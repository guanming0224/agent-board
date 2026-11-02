// 危險指令比對（CONTRACTS §4.3）。規則與指令都先解析成「實際會執行的簡單指令」再比，
// 取捨與判定表見 docs/security-checklist.md「危險指令判定」。這不是沙箱：
// 看得到的變形才擋得到（腳本檔、變數組字、編碼過的內容都看不到）；判斷不出來時往多問的方向走。
import { posix } from 'node:path';

interface Word {
  text: string;
  /** 開頭就是未展開的變數或命令替換，實際值要到執行時才知道。 */
  dynamicHead: boolean;
}

interface SimpleCommand {
  words: Word[];
  /** 輸出接到下一個指令。 */
  pipeNext: boolean;
  /** heredoc、here-string 的內容：只有接給 shell 時才算指令。 */
  stdinText: string[];
  hasRedirect: boolean;
}

interface Parsed {
  commands: SimpleCommand[];
  /** $(...) 與反引號裡的內容，不管外層是什麼指令都會執行。 */
  substitutions: string[];
  balanced: boolean;
}

/** 解析出來、展開完的一層指令。sudo rm 會同時有 sudo 與 rm 兩筆，規則寫 sudo 也比得到。 */
interface Invocation {
  program: string;
  args: Word[];
}

interface Expanded {
  invocations: Invocation[];
  /** 可能含指令文字的單一參數（例如 psql -c "DROP TABLE x"），給子字串比對用。 */
  scriptArgs: string[];
  pipelines: Invocation[][];
  /** 解析不完整（引號沒收、巢狀太深）：退回原始文字比對。 */
  degraded: boolean;
}

const MAX_DEPTH = 8;

const normalizeWhitespace = (text: string): string => text.trim().replace(/\s+/g, ' ');

const baseName = (text: string): string => (text.split('/').pop() ?? text).replace(/\.exe$/i, '');

function closingParen(script: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < script.length; i += 1) {
    const ch = script[i];
    if (ch === '\\' && quote !== "'") i += 1;
    else if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseShell(script: string): Parsed {
  const commands: SimpleCommand[] = [];
  const substitutions: string[] = [];
  let balanced = true;
  let words: Word[] = [];
  let stdinText: string[] = [];
  let hasRedirect = false;
  let word = '';
  let inWord = false;
  let dynamicHead = false;
  let skipNext = false;
  let stdinNext = false;
  let heredocNext = false;
  const heredocs: { delimiter: string; target: string[] }[] = [];

  const endWord = () => {
    if (!inWord) return;
    if (heredocNext) {
      heredocs.push({ delimiter: word, target: stdinText });
      heredocNext = false;
    } else if (stdinNext) {
      stdinText.push(word);
      stdinNext = false;
    } else if (skipNext) {
      skipNext = false;
    } else {
      words.push({ text: word, dynamicHead });
    }
    word = '';
    inWord = false;
    dynamicHead = false;
  };
  const endCommand = (pipeNext: boolean) => {
    endWord();
    if (words.length > 0 || stdinText.length > 0) {
      commands.push({ words, pipeNext, stdinText, hasRedirect });
    }
    words = [];
    stdinText = [];
    hasRedirect = false;
    skipNext = false;
  };
  const push = (text: string) => {
    word += text;
    inWord = true;
  };
  /** 處理 $ 開頭的展開，回傳新的位置（指向最後一個已讀字元）。 */
  const expansion = (i: number): number => {
    const next = script[i + 1];
    const head = word === '';
    if (next === '(') {
      const end = closingParen(script, i + 1);
      if (end < 0) {
        balanced = false;
        substitutions.push(script.slice(i + 2));
        return script.length;
      }
      substitutions.push(script.slice(i + 2, end));
      push('$()');
      if (head) dynamicHead = true;
      return end;
    }
    if (next === '{') {
      const end = script.indexOf('}', i);
      if (end < 0) balanced = false;
      const stop = end < 0 ? script.length : end;
      push(script.slice(i, stop + 1));
      if (head) dynamicHead = true;
      return stop;
    }
    if (next !== undefined && /[A-Za-z0-9_@*#?$!-]/.test(next)) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(script.slice(i + 1))?.[0] ?? next;
      push(`$${name}`);
      if (head) dynamicHead = true;
      return i + name.length;
    }
    push('$');
    return i;
  };
  const backtick = (i: number): number => {
    let end = i + 1;
    while (end < script.length && script[end] !== '`') end += script[end] === '\\' ? 2 : 1;
    if (end >= script.length) balanced = false;
    substitutions.push(script.slice(i + 1, end).replace(/\\(.)/g, '$1'));
    if (word === '') dynamicHead = true;
    push('$()');
    return end;
  };
  const readHeredocs = (start: number): number => {
    let pos = start;
    for (const { delimiter, target } of heredocs.splice(0)) {
      const body: string[] = [];
      for (;;) {
        if (pos >= script.length) break;
        const stop = script.indexOf('\n', pos);
        const line = script.slice(pos, stop < 0 ? script.length : stop);
        pos = stop < 0 ? script.length : stop + 1;
        if (line.replace(/^\t+/, '') === delimiter) break;
        body.push(line);
      }
      target.push(body.join('\n'));
    }
    return pos - 1;
  };

  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i]!;
    if (ch === '\\') {
      if (script[i + 1] === '\n') i += 1;
      else {
        push(script[i + 1] ?? '');
        i += 1;
      }
    } else if (ch === "'") {
      const end = script.indexOf("'", i + 1);
      if (end < 0) balanced = false;
      push(script.slice(i + 1, end < 0 ? script.length : end));
      i = end < 0 ? script.length : end;
    } else if (ch === '"') {
      inWord = true;
      let j = i + 1;
      for (; j < script.length && script[j] !== '"'; j += 1) {
        if (script[j] === '\\') {
          j += 1;
          push(script[j] ?? '');
        } else if (script[j] === '$') j = expansion(j);
        else if (script[j] === '`') j = backtick(j);
        else push(script[j]!);
      }
      if (j >= script.length) balanced = false;
      i = j;
    } else if (ch === '$') {
      if (script[i + 1] === "'") {
        // $'...'：只處理常見跳脫，夠認得 $'rm'。
        const end = script.indexOf("'", i + 2);
        if (end < 0) balanced = false;
        push(script.slice(i + 2, end < 0 ? script.length : end).replace(/\\(.)/g, '$1'));
        i = end < 0 ? script.length : end;
      } else i = expansion(i);
    } else if (ch === '`') {
      i = backtick(i);
    } else if (ch === '#' && !inWord) {
      while (i + 1 < script.length && script[i + 1] !== '\n') i += 1;
    } else if (ch === '\n') {
      endCommand(false);
      if (heredocs.length > 0) i = readHeredocs(i + 1);
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord();
    } else if (ch === ';' || ch === '(' || ch === ')') {
      endCommand(false);
    } else if (ch === '|') {
      const isOr = script[i + 1] === '|';
      endCommand(!isOr);
      if (isOr || script[i + 1] === '&') i += 1;
    } else if (ch === '&') {
      if (script[i + 1] === '>') {
        endWord();
        hasRedirect = true;
        skipNext = true;
        i += script[i + 2] === '>' ? 2 : 1;
      } else {
        endCommand(false);
        if (script[i + 1] === '&') i += 1;
      }
    } else if (ch === '>' || ch === '<') {
      // 2>、10> 的數字是 fd，不是參數。
      if (/^\d+$/.test(word)) {
        word = '';
        inWord = false;
      }
      endWord();
      hasRedirect = true;
      if (script.startsWith('<<<', i)) {
        stdinNext = true;
        i += 2;
      } else if (script.startsWith('<<', i)) {
        heredocNext = true;
        i += script[i + 2] === '-' ? 2 : 1;
      } else {
        if (script[i + 1] === '>') i += 1;
        if (script[i + 1] === '&') i += 1;
        if (script[i + 1] !== '(') skipNext = true;
      }
    } else {
      push(ch);
    }
  }
  endCommand(false);
  return { commands, substitutions, balanced };
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish']);
const KEYWORDS = new Set(
  ['if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'while', 'until', 'esac'].concat(
    '!',
    '{',
    '}',
    '[[',
    ']]',
    'coproc',
  ),
);

/** 只印出或搜尋文字的指令：參數裡出現危險字串不代表要執行。 */
const INERT = new Set(
  'echo printf print true false : grep egrep fgrep rg ag ack cat less more head tail wc man which whereis type test [ ls touch mkdir'.split(
    ' ',
  ),
);
const MESSAGE_FLAG = /^(-[A-Za-z]*m|--(message|body|title|description|subject|notes|grep))$/;
const TEXT_ONLY_GIT = new Set(['log', 'grep', 'show', 'diff', 'blame', 'shortlog']);

/** 包住另一個指令的程式：值是要連下一個字一起跳過的選項。 */
interface WrapperSpec {
  value: string[];
  positional?: number;
  assignments?: boolean;
}

const WRAPPERS: Record<string, WrapperSpec> = {
  sudo: {
    value: '-u -g -h -p -C -T -r -t -U -D -R --user --group --host --prompt --chdir'.split(' '),
    assignments: true,
  },
  doas: { value: ['-u', '-C'] },
  env: { value: ['-u', '-C', '--unset', '--chdir'], assignments: true },
  command: { value: [] },
  builtin: { value: [] },
  exec: { value: ['-a'] },
  nohup: { value: [] },
  time: { value: ['-f', '-o'] },
  nice: { value: ['-n', '--adjustment'] },
  ionice: { value: ['-c', '-n'] },
  stdbuf: { value: ['-i', '-o', '-e'] },
  setsid: { value: [] },
  caffeinate: { value: ['-t', '-w'] },
  busybox: { value: [] },
  timeout: { value: ['-k', '-s', '--kill-after', '--signal'], positional: 1 },
  xargs: {
    value: '-I -L -n -P -s -E -d -a --replace --max-lines --max-args --max-procs'.split(' '),
  },
};

const isAssignment = (text: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(text);

/** 跳過包裝程式自己的選項，回傳被包住的指令從第幾個字開始。 */
function afterWrapperOptions(spec: WrapperSpec, args: Word[]): number {
  let i = 0;
  let positional = spec.positional ?? 0;
  while (i < args.length) {
    const text = args[i]!.text;
    if (text === '--') return i + 1;
    if (text.startsWith('-') && text.length > 1) {
      i += spec.value.includes(text) ? 2 : 1;
    } else if (spec.assignments && isAssignment(text)) {
      i += 1;
    } else if (positional > 0) {
      positional -= 1;
      i += 1;
    } else break;
  }
  return i;
}

function shellScriptArg(args: Word[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const text = args[i]!.text;
    if (text.startsWith('--')) continue;
    if (!text.startsWith('-')) return null;
    if (text.includes('c')) {
      // -c 後面第一個非選項才是腳本（bash -c -x 'cmd' 也合法）。
      const script = args.slice(i + 1).find((w) => !w.text.startsWith('-'));
      return script?.text ?? null;
    }
  }
  return null;
}

/** 提交訊息、PR 內文這類參數只是文字；寫到 rm -rf / 不代表要執行。 */
function isMessageValue(args: Word[], index: number): boolean {
  const inline = /^(--[a-z]+)=/.exec(args[index]!.text)?.[1];
  if (inline && MESSAGE_FLAG.test(inline)) return true;
  const previous = args[index - 1]?.text;
  return previous !== undefined && MESSAGE_FLAG.test(previous);
}

const emptyExpanded = (): Expanded => ({
  invocations: [],
  scriptArgs: [],
  pipelines: [],
  degraded: false,
});

function expandInto(script: string, out: Expanded, depth: number): void {
  if (depth > MAX_DEPTH) {
    out.degraded = true;
    return;
  }
  const parsed = parseShell(script);
  if (!parsed.balanced) out.degraded = true;
  for (const inner of parsed.substitutions) expandInto(inner, out, depth + 1);

  let pipeline: Invocation[] = [];
  parsed.commands.forEach((command, index) => {
    const first = expandCommand(command.words, out, depth);
    if (first) pipeline.push(first);
    const program = first ? first.program : null;
    if (program && SHELLS.has(program)) {
      for (const text of command.stdinText) expandInto(text, out, depth + 1);
    }
    // echo "rm -rf /" | sh：前一個指令印的字會被執行。
    const next = parsed.commands[index + 1];
    const receiver =
      next && command.pipeNext ? expandCommand(next.words, emptyExpanded(), depth) : null;
    if (receiver && SHELLS.has(receiver.program)) {
      const text = command.words
        .slice(1)
        .map((w) => w.text)
        .join(' ');
      expandInto(text, out, depth + 1);
    }
    if (!command.pipeNext) {
      if (pipeline.length > 1) out.pipelines.push(pipeline);
      pipeline = [];
    }
  });
}

function expandCommand(words: Word[], out: Expanded, depth: number): Invocation | null {
  let start = 0;
  while (
    start < words.length &&
    (KEYWORDS.has(words[start]!.text) || isAssignment(words[start]!.text))
  ) {
    start += 1;
  }
  if (start >= words.length) return null;
  const program = baseName(words[start]!.text);
  const args = words.slice(start + 1);
  const invocation: Invocation = { program, args };
  out.invocations.push(invocation);

  const wrapper = WRAPPERS[program];
  if (wrapper) {
    // env -S 'rm -rf /'
    if (program === 'env') {
      const split = args.findIndex((w) => w.text === '-S' || w.text === '--split-string');
      if (split >= 0 && args[split + 1]) expandInto(args[split + 1]!.text, out, depth + 1);
    }
    const rest = args.slice(afterWrapperOptions(wrapper, args));
    // xargs 的目標來自 stdin，內容看不到：當成未知路徑。
    if (program === 'xargs' && rest.length > 0) rest.push({ text: '$()', dynamicHead: true });
    return rest.length > 0 ? (expandCommand(rest, out, depth) ?? invocation) : invocation;
  }
  if (SHELLS.has(program)) {
    const script = shellScriptArg(args);
    if (script !== null) expandInto(script, out, depth + 1);
    return invocation;
  }
  if (program === 'eval' || program === 'watch') {
    const skip =
      program === 'watch' ? afterWrapperOptions({ value: ['-n', '--interval'] }, args) : 0;
    const text = args
      .slice(skip)
      .map((w) => w.text)
      .join(' ');
    expandInto(text, out, depth + 1);
    return invocation;
  }
  if (program === 'find') {
    args.forEach((word, i) => {
      if (!/^-(exec|execdir|ok|okdir)$/.test(word.text)) return;
      const end = args.findIndex(
        (w, j) => j > i && (w.text === ';' || w.text === '+' || w.text === '{}+'),
      );
      // {} 是 find 找到的東西，最遠到搜尋起點，所以用起點來判斷路徑。
      const root = args.find((w) => !w.text.startsWith('-')) ?? { text: '.', dynamicHead: false };
      const inner = args
        .slice(i + 1, end < 0 ? args.length : end)
        .map((w) => (w.text === '{}' ? root : w));
      expandCommand(inner, out, depth);
    });
    return invocation;
  }

  const textOnlyGit = program === 'git' && TEXT_ONLY_GIT.has(gitParts(args).positionals[0] ?? '');
  if (!INERT.has(program) && !textOnlyGit) {
    args.forEach((word, i) => {
      if (isMessageValue(args, i) || !/\s/.test(word.text)) return;
      // ssh host 'rm -r -f /'、psql -c "DROP TABLE x"：參數本身可能是腳本。
      out.scriptArgs.push(word.text);
      expandInto(word.text, out, depth + 1);
    });
  }
  return invocation;
}

/** git 的全域選項放在子指令前面，有些要吃掉下一個字。 */
const GIT_GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

function gitParts(args: Word[]): { positionals: string[] } {
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const text = args[i]!.text;
    if (positionals.length === 0 && GIT_GLOBAL_VALUE.has(text)) i += 1;
    else if (!text.startsWith('-')) positionals.push(text);
  }
  return { positionals };
}

function flagAlias(program: string, subcommand: string | null, flag: string): string {
  if (program === 'rm') {
    if (flag === '-R' || flag === '--recursive') return '-r';
    if (flag === '--force') return '-f';
  }
  if (program === 'git' && subcommand === 'push') {
    if (flag === '-f' || flag === '--force-with-lease' || flag === '--force-if-includes') {
      return '--force';
    }
  }
  return flag;
}

interface ParsedArgs {
  flags: Set<string>;
  positionals: Word[];
}

function parseArgs(program: string, args: Word[]): ParsedArgs {
  const flags = new Set<string>();
  const positionals: Word[] = [];
  let rest = args;
  if (program === 'git') {
    let i = 0;
    while (i < rest.length && rest[i]!.text.startsWith('-')) {
      i += GIT_GLOBAL_VALUE.has(rest[i]!.text) ? 2 : 1;
    }
    rest = rest.slice(i);
  }
  const subcommand = program === 'git' ? (rest[0]?.text ?? null) : null;
  let onlyPositional = false;
  for (const word of rest) {
    const { text } = word;
    if (onlyPositional || !text.startsWith('-') || text === '-') {
      positionals.push(word);
    } else if (text === '--') {
      onlyPositional = true;
    } else if (text.startsWith('--')) {
      flags.add(flagAlias(program, subcommand, text.split('=')[0]!));
    } else {
      for (const letter of text.slice(1)) flags.add(flagAlias(program, subcommand, `-${letter}`));
    }
  }
  // git push origin +main 就是 force。
  if (subcommand === 'push' && positionals.slice(1).some((w) => w.text.startsWith('+'))) {
    flags.add('--force');
  }
  return { flags, positionals };
}

const isPathLike = (text: string): boolean => /^(\/|~|\.\.?(\/|$)|\*)/.test(text);

/** 目標路徑有沒有打到規則的路徑。判斷不出來（變數、~）就當打到。 */
function hitsPath(rulePath: string, target: Word): boolean {
  const text = target.text;
  if (target.dynamicHead || text.startsWith('~')) return true;
  const rule = posix.normalize(rulePath);
  const value = posix.normalize(text.replace(/\/\*$/, '/').replace(/^\*$/, '.'));
  if (value.startsWith('/')) {
    const under = (a: string, b: string) => a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`);
    return under(value, rule) || under(rule, value);
  }
  // 相對路徑只在清掉整個工作目錄或跳出去時才算碰到 /。
  if (rule === '/') return value === '.' || value === './' || value.startsWith('..');
  return value === rule;
}

interface CommandRule {
  kind: 'command';
  program: string;
  flags: Set<string>;
  positionals: string[];
}
interface PipelineRule {
  kind: 'pipeline';
  segments: CommandRule[];
}
interface TextRule {
  kind: 'text';
  needle: string;
}
type Rule = CommandRule | PipelineRule | TextRule;

function toCommandRule(command: SimpleCommand): CommandRule | null {
  const [head, ...rest] = command.words;
  if (!head) return null;
  const program = baseName(head.text);
  const { flags, positionals } = parseArgs(program, rest);
  return { kind: 'command', program, flags, positionals: positionals.map((w) => w.text) };
}

function compileRule(raw: string): Rule | null {
  const rule = raw.trim();
  if (!rule) return null;
  // text: 是逃生口：比對原始文字，引號裡的也算。
  if (rule.startsWith('text:')) {
    const needle = normalizeWhitespace(rule.slice(5));
    return needle ? { kind: 'text', needle } : null;
  }
  const parsed = parseShell(rule);
  const simple =
    parsed.balanced &&
    parsed.substitutions.length === 0 &&
    parsed.commands.every((c) => !c.hasRedirect && c.stdinText.length === 0);
  const segments = parsed.commands.map(toCommandRule);
  if (simple && segments.every((s) => s !== null)) {
    if (segments.length === 1) return segments[0] as CommandRule;
    if (segments.length > 1 && parsed.commands.slice(0, -1).every((c) => c.pipeNext)) {
      return { kind: 'pipeline', segments: segments as CommandRule[] };
    }
  }
  return { kind: 'text', needle: normalizeWhitespace(rule) };
}

function programMatches(rule: string, program: string): boolean {
  // 規則寫 mkfs 也要比到 mkfs.ext4。
  return program === rule || program.startsWith(`${rule}.`);
}

function matchesPositionals(rule: CommandRule, positionals: Word[]): boolean {
  let cursor = 0;
  for (const [index, expected] of rule.positionals.entries()) {
    if (isPathLike(expected)) {
      if (!positionals.some((word) => hitsPath(expected, word))) return false;
      continue;
    }
    const equals = (word: Word | undefined) =>
      word !== undefined &&
      (expected.endsWith('=') ? word.text.startsWith(expected) : word.text === expected);
    // git 的子指令要在第一位，git stash push 不算 git push。
    if (rule.program === 'git' && index === 0) {
      if (!equals(positionals[0])) return false;
      cursor = 1;
      continue;
    }
    while (cursor < positionals.length && !equals(positionals[cursor])) cursor += 1;
    if (cursor >= positionals.length) return false;
    cursor += 1;
  }
  return true;
}

function matchesInvocation(rule: CommandRule, invocation: Invocation): boolean {
  if (!programMatches(rule.program, invocation.program)) return false;
  const { flags, positionals } = parseArgs(invocation.program, invocation.args);
  for (const flag of rule.flags) if (!flags.has(flag)) return false;
  return matchesPositionals(rule, positionals);
}

/** 規則文字出現在單一參數裡。邊界是英數字時要有斷字，rm 才不會比到 firmware。 */
function containsWords(text: string, needle: string): boolean {
  const isWord = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);
  let at = text.indexOf(needle);
  while (at >= 0) {
    const leftOk = !isWord(needle[0]) || !isWord(text[at - 1]);
    const rightOk = !isWord(needle[needle.length - 1]) || !isWord(text[at + needle.length]);
    if (leftOk && rightOk) return true;
    at = text.indexOf(needle, at + 1);
  }
  return false;
}

function matchesRule(rule: Rule, raw: string, rawRule: string, expanded: Expanded): boolean {
  if (rule.kind === 'text') return raw.includes(rule.needle);
  // 解析不完整時，原本的子字串比對是最後防線。
  if (expanded.degraded && raw.includes(normalizeWhitespace(rawRule))) return true;
  if (rule.kind === 'pipeline') {
    return expanded.pipelines.some((pipeline) =>
      pipeline.some((_, start) =>
        rule.segments.every((segment, offset) => {
          const invocation = pipeline[start + offset];
          return invocation !== undefined && matchesInvocation(segment, invocation);
        }),
      ),
    );
  }
  if (expanded.invocations.some((invocation) => matchesInvocation(rule, invocation))) return true;
  const needle = normalizeWhitespace(rawRule);
  return expanded.scriptArgs.some((arg) => containsWords(normalizeWhitespace(arg), needle));
}

/** 回傳第一條命中的規則；沒有命中回 null。 */
export function matchDangerRule(command: string, rules: readonly string[]): string | null {
  const expanded = emptyExpanded();
  expandInto(command, expanded, 0);
  const raw = normalizeWhitespace(command);
  for (const rawRule of rules) {
    const rule = compileRule(rawRule);
    if (rule && matchesRule(rule, raw, rawRule, expanded)) return rawRule;
  }
  return null;
}
