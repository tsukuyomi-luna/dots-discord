# dots-discord

Discord の新着を dots へ届け、dots から Discord に返信するセルフホスト用プラグイン。

```text
Discord Bot → Gateway → 永続キュー → MCP Events Webhook → dots
Discord Bot ← REST    ← MCP tools                    ← dots
```

非公式・実験段階。MCP 2.0 (`2026-07-28`) と OpenAI の MCP Events 仕様に対応した実装です。実際の dots アカウントと Discord サーバーを接続した実機検証はまだ行っていません。GitHub への公開は、公式プラグイン審査の通過や利用アカウントでの提供を意味しません。

## できること

- チャンネル一覧、履歴、個別メッセージの取得と返信
- 人間の新着メッセージを署名付き Webhook で通知
- チャンネル・サーバー・履歴期間・書き込み可否をサーバー側で制限
- OAuth 認証、通知先の検証、再送、期限更新、再起動後のキュー復元

1 インスタンス = 1 人の運用者・1 OAuth クライアントです。別の利用者は別インスタンスと DB を使ってください。DM、添付ファイルのダウンロード／投稿、メッセージ編集・削除、サーバー横断検索は公開しません。スレッドは親チャンネルと別の ID として明示登録します。

## 起動

Node.js 24.21 以降、pnpm 12.6、常時動くホストと HTTPS ドメインが必要です。

```sh
git clone https://github.com/tsukuyomi-luna/dots-discord.git
cd dots-discord
pnpm install --frozen-lockfile
cp config.example.json config.json
cp .env.example .env
chmod 600 .env config.json
# config.json と .env を編集
pnpm check
pnpm start
```

1. [Discord Developer Portal](https://discord.com/developers/applications) で専用 Bot を作成し、**Message Content Intent** を有効にする
2. 許可するチャンネルだけに `View Channel`、`Read Message History`、`Send Messages` を付与。スレッドに返信する場合は `Send Messages in Threads` も付与。Administrator は不要
3. `.env` に Bot トークンと、別々に生成した `OAUTH_CLIENT_SECRET` / `OWNER_PASSWORD` を設定する。乱数はそれぞれ `openssl rand -hex 32` で生成できる
4. `config.json` のドメイン、guild/channel ID、読ませる期間を設定する
5. HTTPS リバースプロキシから `127.0.0.1:8788` へ転送する。Host ヘッダーは公開ドメインを保持する。例は `deploy/`

秘密値をチャットに貼らないでください。サーバーは Bot トークンを dots に渡しません。

### 公開範囲

| 設定                        | 意味                                                       |
| --------------------------- | ---------------------------------------------------------- |
| `channels[].id` / `guildId` | 一致するチャンネルだけ許可。ワイルドカードなし             |
| `since`                     | この時刻より前は読まない。タイムゾーン付き ISO 8601        |
| `historyHours`              | さらに直近 N 時間に制限。既定 168 時間                     |
| `until`                     | 読めるメッセージの上限時刻。それ以後の新着通知・送信も停止 |
| `write`                     | 既定 false。返信にも true が必要                           |
| `events`                    | `mentions`（既定）/ `all` / `off`                          |
| `callbackHosts`             | Webhook の送信先ホストを完全一致で許可                     |

`mentions` はこの専用 Bot へのメンションがある人間の投稿のみ通知します。`all` にしても購読時の `mentions_only` は既定 true です。全投稿を監視するには両方で明示的に変更します。

設定変更は再起動で反映します。再起動時・送信直前にもキューの権限と履歴範囲を確認します。返信元も同じ制限を通します。リンク、引用、転送先から別チャンネルの本文を自動取得しません。

## dots に接続

1. 利用環境でカスタムプラグイン／リモート MCP を追加し、URL を `https://自分のドメイン/mcp` にする
2. 認証を OAuth にし、`config.json` の `clientId` と `.env` の `OAUTH_CLIENT_SECRET` を登録する
3. 接続画面に表示される OAuth リダイレクト URI を `oauth.redirectUris` に完全一致で設定する。サーバーは `iss` 対応を広告し、サンプルには公式の共通コールバックを記載している
4. 自分の公開ドメイン上の認証ページで共有範囲を確認し、`OWNER_PASSWORD` で許可する
5. `discord_list_channels` で範囲を確認し、dots に購読を依頼する

例として「この Bot がメンションされた新着を監視して、必要なときだけそのチャンネルへ返信して。私との非公開会話は持ち出さないで」と指定できます。

プラグインパッケージが必要な導入方式では次で ZIP を作れます。含まれるのは `plugin.json` と、指定した公開 URL の `mcp.json` だけです。

```sh
pnpm plugin:pack https://自分の公開ドメイン
```

`callbackHosts` のサンプルは通知先の保証ではありません。実際に MCP Events が指定するホストを確認し、信頼できる送信先だけ設定してください。許可外の場合は購読時に `destination_not_allowed` を返し、送信しません。ローカル／プライベート IP はホストを列挙しても拒否します。

接続方法・利用可否は [公式プラグイン手順](https://developers.openai.com/plugins/quickstart) と [OAuth 認証](https://developers.openai.com/plugins/build/auth) を参照してください。OAuth は事前登録方式です。CIMD / 動的クライアント登録は実装していません。

## MCP インターフェース

| Tool                    | 入力                                                           |
| ----------------------- | -------------------------------------------------------------- |
| `get_profile`           | 接続を識別する不透明 ID。Discord 本人確認ではない              |
| `discord_list_channels` | なし                                                           |
| `discord_read_messages` | `channel_id`, `limit`（1–50）, 任意 `before`                   |
| `discord_get_message`   | `channel_id`, `message_id`                                     |
| `discord_send_message`  | `channel_id`, `content`, `idempotency_key`, 任意 `reply_to_id` |

送信は 2,000 文字まで。全種類の通知メンションを無効化しています。同じキー・同じ内容の再送は 7 日間抑止し、内容変更はエラーにします。通信切断などで結果不明になった場合は送信をやり直さず、履歴を確認してください。

Event は `message.created`。引数は `channel_id` と任意 `mentions_only`。`events/list`, `events/subscribe`, `events/unsubscribe` を同じ認証付きエンドポイントに実装しています。

```json
{
  "name": "message.created",
  "arguments": { "channel_id": "111111111111111111", "mentions_only": true },
  "delivery": {
    "mode": "webhook",
    "url": "https://通知先のホスト/コールバック",
    "secret": "whsec_Base64で表した24〜64バイトの鍵"
  },
  "cursor": null,
  "ttlMs": 3600000
}
```

この URL と署名鍵は購読するクライアントが渡す値で、利用者が Discord Bot トークンを入れる場所ではありません。

## 運用上の制約

- 購読は既定／最大 24 時間、最小 60 秒。`refreshBefore` までに更新が必要
- Webhook 検証、Standard Webhooks HMAC、5 分間の鍵切り替え猶予、指数バックオフ（最大 8 試行）を実装
- 同じ購読では FIFO。イベントは重複して届く可能性があるため受信側でも `eventId` を扱う
- Gateway の停止中の新着は自動で埋め戻さない。カーソル再生、polling、streaming 配信なし
- Bot・Webhook・自身の投稿はイベント対象外。無限返信を防ぐ
- 通知前の編集・削除は、元の本文を通知せず破棄。既に外部へ送信した情報は取り消せない
- キュー上限 1,024 件、購読上限 32 件。超過や再送終了は内容を含まない警告ログに残す
- OAuth の許可は 30 日で再認証。アクセストークンは 15 分、refresh token は一回ごとに更新。古い refresh token の再使用は許可全体を失効させる
- OAuth の revoke は該当する許可を失効させ、後続の通知も停止する。既に通信中の通知は取り消せない
- SQLite と `.env` は秘密情報。詳しくは [SECURITY.md](SECURITY.md)

## 検証

`pnpm check` で format、lint、型、テスト、ビルドを実行します。HTTP の OAuth → MCP discovery/購読 → 模擬 Gateway → 署名付き通知 → 返信、範囲外取得、再送・再起動・取り消しをテストしています。

テストの Discord REST/Gateway と Webhook 宛先はダブルです。実アカウントでのプラグイン登録、実 Gateway 再接続、公開 TLS の配備は未検証です。本番導入時は専用テストチャンネルで往復と停止を確認してください。

仕様は [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)、[プラグイン形式](https://developers.openai.com/plugins/build/plugins)、[MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28) を参照。モデル API を直接呼ばず、AI の返信判断・実行は接続先の dots が行います。
