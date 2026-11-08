import { describe, expect, it } from 'vitest';
import {
  findTerms,
  foldCase,
  makeSnippet,
  parseSearchTerms,
  SEARCH_SNIPPET_MAX,
  SearchQuery,
} from './index';

describe('parseSearchTerms', () => {
  it('空白分隔的詞、雙引號片語、轉小寫、去重複', () => {
    expect(parseSearchTerms('Risk.py  fee')).toEqual(['risk.py', 'fee']);
    expect(parseSearchTerms('"手續費  0.1425" x1')).toEqual(['手續費 0.1425', 'x1']);
    expect(parseSearchTerms('abc ABC')).toEqual(['abc']);
    // 沒收尾的引號：當片語到結尾
    expect(parseSearchTerms('"open ended')).toEqual(['open ended']);
  });

  it('少於 2 個字不搜', () => {
    expect(parseSearchTerms('a')).toEqual([]);
    expect(parseSearchTerms('  "" ')).toEqual([]);
    expect(parseSearchTerms('費')).toEqual([]);
    expect(parseSearchTerms('費用')).toEqual(['費用']);
  });
});

describe('findTerms / makeSnippet', () => {
  it('每個詞都要出現（AND）；片語要連在一起', () => {
    const text = '手續費是 0.1425，另外 0.1425 也出現';
    expect(findTerms(foldCase(text), parseSearchTerms('手續費 0.1425'))).not.toBeNull();
    expect(findTerms(foldCase(text), parseSearchTerms('"手續費 0.1425"'))).toBeNull();
    expect(findTerms(foldCase('手續費 0.1425'), parseSearchTerms('"手續費 0.1425"'))).toEqual([
      [0, 10],
    ]);
    expect(findTerms(foldCase(text), parseSearchTerms('手續費 不存在'))).toBeNull();
  });

  it('不分大小寫，位置對回原字串', () => {
    const hit = makeSnippet('Edit src/Risk.PY now', parseSearchTerms('risk.py'));
    expect(hit).toEqual({ snippet: 'Edit src/Risk.PY now', matchRanges: [[9, 16]] });
  });

  it('長文字只留命中處前後 ≤ 160 字，被截的那邊加省略號，命中位置跟著移動', () => {
    const text = `${'a'.repeat(500)} needle ${'b'.repeat(500)}`;
    const hit = makeSnippet(text, ['needle'])!;
    expect(hit.snippet.length).toBeLessThanOrEqual(SEARCH_SNIPPET_MAX);
    expect(hit.snippet.startsWith('…')).toBe(true);
    expect(hit.snippet.endsWith('…')).toBe(true);
    const [[start, end]] = hit.matchRanges as [[number, number]];
    expect(hit.snippet.slice(start, end)).toBe('needle');
  });

  it('換行併成一個空白；開頭命中時前面不加省略號', () => {
    const hit = makeSnippet(`needle\n\n${'x '.repeat(200)}`, ['needle'])!;
    expect(hit.snippet.startsWith('needle x x')).toBe(true);
    expect(hit.snippet.endsWith('…')).toBe(true);
    expect(hit.matchRanges[0]).toEqual([0, 6]);
  });

  it('不把 emoji 切成兩半', () => {
    const text = `${'😀'.repeat(200)}needle${'😀'.repeat(200)}`;
    const hit = makeSnippet(text, ['needle'])!;
    expect(hit.snippet).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(hit.snippet).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});

describe('SearchQuery', () => {
  it('預設：全部工作區、7 天、不含封存、不遮蔽', () => {
    expect(SearchQuery.parse({ q: 'abc' })).toEqual({
      q: 'abc',
      scope: 'all',
      since: '7d',
      archived: false,
      mask: false,
    });
    expect(SearchQuery.parse({ q: 'x', archived: '1', mask: '1', since: '30d' })).toMatchObject({
      archived: true,
      mask: true,
      since: '30d',
    });
    expect(SearchQuery.safeParse({ q: 'x'.repeat(201) }).success).toBe(false);
  });
});
