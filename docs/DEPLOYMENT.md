# 本番公開と残作業

## 現在の構成

- UI: GitHub Pages / mainへのpush → 自動テスト → distだけを公開
- API: Cloudflare Worker + SQLite Durable Objects（ファイル本体のストレージなし）
- 実際の転送先: ギガファイル便の非公式ブラウザ用エンドポイント
- 初期状態: apiBase未設定 / INTEGRATION_APPROVED=false / 送信停止

GitHub Pagesは認証済みアカウントで作成済みです。公開URLは https://alicetel-u.github.io/RakuTools/ 。Actionsの`Publish RakuTools`で最新コミットの完了を確認してください。

## 必要なユーザー操作

### 1. 直接連携の運用条件を確認

運営元の公式窓口 https://gigafile.nu/contact-us.php に、次の条件で利用可能か確認してください。こちらから問い合わせは送信していません。

- 公開WebサービスRakuToolsから、利用者のファイルをCloudflare Worker経由で転送したい
- 利用者はRakuTools内で選択・送信・共有URL取得を完結させる
- ブラウザ用のupload_chunk.phpに依存してよいか。提供可能な公式APIがあるか
- 8 MiB分割の可否、日次/同時実行の許容上限、運用方法、名称使用と表示条件
- 商用/非商用、広告等の扱い、サポート・仕様変更の連絡方法

回答が得られない・条件に合わない場合は連携を有効にしないでください。確認資料は公開リポジトリへ個人情報を含めず、別途保管してください。

### 2. Cloudflareを設定

Cloudflareアカウントでログインが必要です。秘密キーをこのチャットやconfig.jsに貼り付けないでください。

```sh
npm ci
npx wrangler login
npx wrangler whoami
```

CloudflareでTurnstileのManagedウィジェットを作成し、許可ホストを`alicetel-u.github.io`に限定します。サイトキー（公開キー）を`worker/wrangler.toml`の`TURNSTILE_SITE_KEY`に入れ、秘密キーは次の対話入力で登録します。

```sh
npx wrangler secret put TURNSTILE_SECRET --config worker/wrangler.toml
npx wrangler secret put IP_HASH_SECRET --config worker/wrangler.toml
```

IP_HASH_SECRETは32文字以上の安全なランダム値を使ってください。ログやGitには残さないでください。最初のWorkerが未作成の場合、まずINTEGRATION_APPROVED=falseのまま次のdeployを実行し、作成してからsecretを登録してください。

```sh
npx wrangler deploy --config worker/wrangler.toml
```

WorkerのURLを`config.js`のapiBaseへ設定します。既定のCSPは`https://*.workers.dev`を許可しています。独自ドメインを使う場合はindex.htmlのconnect-srcも必要なホストだけ追加してください。ALLOWED_ORIGINSはパスを含めないOriginです。GitHub Pagesの同一ユーザー配下の他サイトも同じOriginを持つため、CORSは認証の代用になりません。

### 3. 自動デプロイ

GitHubのSettings → Secrets and variables → Actionsに設定します。

- Secret `CLOUDFLARE_API_TOKEN`: 対象アカウントに限定したWorkers Scripts編集権限。使用CLI・CloudflareアカウントのDurable Objectsデプロイに必要な権限も確認
- Secret `CLOUDFLARE_ACCOUNT_ID`: 対象アカウントID
- Variable `RAKUTOOLS_DEPLOY_WORKER`: `true`

`Deploy upload Worker`ワークフローを実行します。以後worker・lockfile・ワークフロー変更のmain pushで自動実行します。TurnstileとIP_HASH_SECRETはWorker secretとして残ります。wrangler.tomlのvarsはデプロイごとに反映されます。

### 4. 本番経由の実測を行ってから一般利用開始

連携の運用条件を確認できた後、限定した検証環境で`INTEGRATION_APPROVED=true`にし、必要な安全設定をすべて投入して検証してください。このフラグは「許諾を自動的に取得する設定」ではありません。

- 小さなテキスト：RakuTools画面で選択→送信→URLコピー→別ブラウザでダウンロード→ハッシュ一致
- 2個以上のファイル・空ファイル・8 MiBを超えるファイル：分割境界と順序、部分成功
- 段階的にサイズを増やす：大容量の所要時間、CPU/メモリ、無料枠消費
- 保存期間全候補：上流の保持期限と照合
- モバイル実機、Wi-Fi/回線変更、中止、タブ終了、通信切断：結果不明を誤表示しない
- 実Turnstileの正常・期限切れ・偽トークン、Origin/セッション/サイズ拒否、日次上限
- 複数ユーザーの同時実行。無料枠を超える前に停止できること

検証結果を記録し、準備中の案内・description等を実態に合わせて更新してから本番へ反映してください。開発中のメタデータ表示は運用開始時にも確認が必要です。現時点ではこの工程は未実施です。

## 緊急停止

`INTEGRATION_APPROVED=false`をデプロイすればAPIは全新規送信・チャンクを503で拒否します。進行中の上流リクエストは完了する場合があります。必要に応じてCloudflareでWorkerのルートも停止してください。フロントのapiBaseを空にするだけでは既存API呼び出しは止められません。

日次利用量はUTC基準（日本時間9時）で切り替わります。未完了・失敗分も予約容量としてカウントし、安全側に制限します。IP変更時にはセッションを拒否します。長時間送信中の携帯回線の切り替えには未対応です。

## 連携できない場合の代替案

RakuTools独自のファイル共有サービスとして、Cloudflare R2等の公式ストレージAPI・署名付きmultipartアップロード・期限削除・共有用ダウンロードAPIを使う構成が候補です。外部サイトで操作させずに完結できますが、ギガファイル便への転送ではなく独自保管となるため、名称・プライバシーポリシー・利用量・費用・不正ファイル対応を改めて設計する必要があります。今回は無断で転送先を変更していません。無料枠と課金条件は採用時に公式の最新料金を確認してください。
