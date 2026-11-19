# RakuTools — らくらくギガファイル便

初心者でも使いやすいファイル共有ツールです。

## 実装状況

- ファイル選択 / ドラッグ＆ドロップ / 複数ファイル
- 保存期間選択（7・30・60・100日）
- 分割アップロード、進捗表示、共有URL取得・コピー、削除キー表示
- スマートフォン対応
- GitHub Pagesの画面とCloudflare Workersの送信APIを分離

**重要：ギガファイル便への実際のアップロード成功は未検証です。** これはギガファイル便の非公式連携です。公開APIの互換性保証はありません。外部への一般公開前に、仕様・利用条件・負荷・悪用対策について確認してください。

## 公開設定

GitHub Pagesだけでは直接アップロードできません。Cloudflare Workerを別途公開する必要があります。

1. Cloudflareのアカウントで `npx wrangler login`
2. `cd worker && npx wrangler deploy`
3. 返されたWorkersのURL（例：`https://rakutools-upload.example.workers.dev`）をルートの `config.js` に設定：`window.RAKUTOOLS_API_BASE = 'https://...workers.dev';`
4. commit & pushすると GitHub Pages が自動更新されます。
5. 小さなテストファイルで送信・URL取得・実ダウンロードを検証してください。

公開ページはGitHub Pagesが有効な場合 `https://alicetel-u.github.io/RakuTools/` です。

### プライバシーと制限

ファイルはブラウザからCloudflare Workerを経由してギガファイル便へ送られます。RakuTools側に永続保存しませんが、Cloudflareが中継します。Workerはギガファイル便のホストのみへ転送し、1チャンク12MiB以下に制限します。Cloudflareの利用料金・リクエスト制限が別途適用されます。

**現状のWorkerは一般公開用の濫用対策が十分ではありません。** 公開運用前にTurnstile、送信レート制限、日次上限、監視、運営会社への確認などが必要です。未公開の送信仕様に依存しているため、将来動かなくなる可能性があります。
