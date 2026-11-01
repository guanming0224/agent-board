"""GitHub 自動推送（deploy/git-hooks/autopush.sh）的檢查與通知，不會印出任何金鑰。

    git log -p ... | python3 autopush_check.py scan     # 有問題：exit 1，stdout 印原因（不含金鑰本身）
    python3 autopush_check.py notify <種類> <訊息>      # 發桌面通知；同一則訊息 6 小時內只發一次
    python3 autopush_check.py resolved <訊息>           # 之前發過問題通知才發「已恢復」，並清掉紀錄

真實值清單放 <git-common-dir>/autopush-private-values，一行一個（金鑰、機器名稱、個人網域），
不進版控。這個專案會公開發布，所以這些字串不能出現在 repo，連比對清單也不行。
"""
import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MIN_SECRET_LEN = 4          # 太短的值比對會誤擋，不比
REPEAT_SECONDS = 6 * 3600   # 同一則訊息多久內不重發

PATTERNS = [
    ('Anthropic API Key', re.compile(r'\bsk-ant-[A-Za-z0-9_-]{20,}')),
    ('GitHub Token', re.compile(r'\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b')),
    ('Telegram Bot Token', re.compile(r'\b[0-9]{8,10}:[A-Za-z0-9_-]{30,}\b')),
    ('私鑰區塊', re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----')),
]
UUID = re.compile(r'\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b')
KEY_WORDS = re.compile(r'api[_-]?key|apikey|secret|passphrase|password|token', re.I)


def git_dir():
    try:
        out = subprocess.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd=ROOT,
                             capture_output=True, text=True, timeout=10).stdout.strip()
        return out or os.path.join(ROOT, '.git')
    except Exception:
        return os.path.join(ROOT, '.git')


def real_secrets():
    try:
        with open(os.path.join(git_dir(), 'autopush-private-values'), encoding='utf-8') as f:
            lines = [line.strip() for line in f]
    except OSError:
        return []
    return [v for v in lines if len(v) >= MIN_SECRET_LEN and not v.startswith('#')]


def scan(diff, secrets):
    """回傳第一個問題的原因（不含金鑰本身），沒問題回傳空字串。"""
    for line in diff.splitlines():
        if not line.startswith('+') or line.startswith('+++'):
            continue
        for value in secrets:
            if value in line:
                return '新增內容裡有 autopush-private-values 清單中的真實值'
        for name, pattern in PATTERNS:
            if pattern.search(line):
                return '新增內容裡有像 %s 的字串' % name
        if UUID.search(line) and KEY_WORDS.search(line):
            return '新增內容裡有像金鑰的字串（key / secret / token 旁邊有 UUID）'
    return ''


def state_path():
    return os.path.join(git_dir(), 'autopush-alerts.json')


def load_state():
    try:
        with open(state_path(), encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    tmp = state_path() + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(state, f)
    os.replace(tmp, state_path())


def send(text):
    """測試時設 AUTOPUSH_NOTIFY_FILE，把訊息寫進檔案而不是真的發。"""
    sink = os.environ.get('AUTOPUSH_NOTIFY_FILE')
    if sink:
        with open(sink, 'a', encoding='utf-8') as f:
            f.write(text + '\n')
        return True
    # 訊息用 argv 傳，不拼進 AppleScript 字串，避免引號造成注入
    script = 'on run argv\ndisplay notification (item 1 of argv) with title "Agent Board 自動推送"\nend run'
    try:
        subprocess.run(['osascript', '-e', script, text], check=True, capture_output=True, timeout=15)
        return True
    except Exception as e:
        print('通知失敗：%s' % type(e).__name__)
        return False


def main(argv):
    if len(argv) >= 2 and argv[1] == 'scan':
        reason = scan(sys.stdin.read(), real_secrets())
        if reason:
            print(reason)
            return 1
        return 0
    if len(argv) >= 4 and argv[1] == 'notify':
        key = '%s:%s' % (argv[2], argv[3])
        state = load_state()
        now = time.time()
        if now - float(state.get(key, 0)) < REPEAT_SECONDS:
            return 0
        if send(argv[3]):
            state[key] = now
            save_state(state)
        return 0
    if len(argv) >= 3 and argv[1] == 'resolved':
        if load_state():
            send(argv[2])
            save_state({})
        return 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
