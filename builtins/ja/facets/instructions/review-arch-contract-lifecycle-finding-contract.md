{{include:instructions/review-arch}}

## Finding Contract 追加手順

- Contract Lifecycle Knowledge の全セクションを、アーキテクチャ観点と同じレビュー内で適用する
- 変更された要件・契約ごとに、公開入口、producer、validator、consumer、対応テストを追跡する
- 変更された資源ごとに、owner と移譲、last consumer、release または persist を、成功・失敗・中断・再試行の各経路で追跡する
- 証跡を確認できない項目は推測で補わず、出力契約の証跡表で未確認と明示する
