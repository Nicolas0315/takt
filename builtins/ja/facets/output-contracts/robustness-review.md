```markdown
# 堅牢性レビュー

## 結果: APPROVE / REJECT

## サマリー
{1-2文の結論}

## 今回の指摘（new）
| # | finding_id | family_tag | 重大度 | 場所 | 問題 | 壊れる条件 | 修正案 |
|---|------------|------------|--------|------|------|------------|--------|
| 1 | ROB-NEW-src-file-L42 | robustness | High / Medium / Low | `src/file.ts:42` | {問題} | {失敗・再試行・中断などの条件} | {修正案} |

## 継続指摘（persists）
| finding_id | 前回根拠 | 今回根拠 | 問題 | 修正案 |
|------------|----------|----------|------|--------|
| ROB-PERSIST-src-file-L77 | `src/file.ts:77` | `src/file.ts:77` | {未解消の問題} | {修正案} |

## 解消済み（resolved）
| finding_id | 元の期待結果 | 解消根拠 |
|------------|--------------|----------|
| ROB-RESOLVED-src-file-L10 | {元findingの受入条件} | `src/file.ts:10` で解消 |

## 再開指摘（reopened）
| finding_id | 再現手順 | 期待結果 | 実結果 | 場所 |
|------------|----------|----------|--------|------|
| ROB-REOPENED-src-file-L55 | {再現手順} | {期待結果} | {実結果} | `src/file.ts:55` |

## 検証証跡
- 失敗経路: {確認対象・確認内容・結果}
- 再試行・中断・後始末: {確認対象・確認内容・結果}

## REJECT判定条件
- `new`、`persists`、または`reopened`が1件以上ある場合のみREJECT
- `finding_id`なしの指摘は無効
```

**認知負荷軽減ルール:**
- APPROVE → サマリーと検証証跡のみ
- REJECT → 該当指摘のみ表で記載（30行以内）
