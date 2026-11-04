# 網路流量大作戰(流量拔河 + 偷鑽石)

企業電腦網路課程的互動展示:觀眾用手機點擊,產生真實的網路流量,投影幕即時顯示兩隊的對抗。
比分直接讀取伺服器網卡的實際 Bytes / Packets,與 Zabbix agent、ntopng 量到的是同一份數據。

| 遊戲 | 玩法 | 要講的網管概念 |
|---|---|---|
| 🪢 流量拔河 | A 隊每次點擊下載一大包資料;B 隊每次點擊連發多個極小請求。先依流量 Bytes 拉繩,結束後主持人按「反轉」改依封包數計算 | 流量大不等於封包多;小封包洪水是 DDoS 常見手法 |
| 💎 偷鑽石 | 點一次前進一步並產生流量。全隊流量超過門檻連續 2 秒,就被監視器偵測、出局。門檻與終點依各隊人數自動調整 | 網管用門檻偵測異常,攻擊者會壓低流量躲避偵測 |

## 架構

```
手機 ── Cloudflare ── cloudflared(VM 1)──┬─→ VM 2:8100  TEAM=A  ← tug-a 網址
                                          └─→ VM 3:8100  TEAM=B  ← tug-b 網址
```

- 兩台 VM 跑**同一份程式**,以 `.env` 的 `TEAM` 切換隊伍,都使用 Port 8100。
- 玩家掃同一個 QR Code(`JOIN_URL`,預設是 A 的網址)→ 選隊 → 被導到自己隊伍的網址。點擊只送到自己隊伍的 VM,所以每台 VM 的網卡流量就代表一隊。
- 即時畫面用 **Server-Sent Events**(`/events`,一般 HTTP 長連線)推送,每秒一次。手機與投影頁會同時訂閱 A、B 兩台,在瀏覽器合併畫面,兩台 VM 之間不需要互相連線。
- 狀態全部存在記憶體,不需要資料庫。

## 系統需求

- Ubuntu Server 26.04 LTS(x86-64),Python 3.10 以上
- 套件:`starlette`、`uvicorn`(純 Python,無編譯需求)
- 不需要 root 權限、不需要額外系統套件;讀取 `/sys/class/net/<IFACE>/statistics/` 一般使用者即可

## 安裝(VM 2、VM 3 各做一次)

```bash
mkdir -p ~/games && cd ~/games
git clone <此 Repository 網址> traffic-tug
cd traffic-tug
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
nano .env        # 改 TEAM、IFACE、PUBLIC_URL_A/B、ADMIN_TOKEN、ALERT_TOKEN
.venv/bin/python -m app     # 前景測試,Ctrl+C 結束
```

安裝成服務:

```bash
sed -i "s/USERNAME/$USER/g" deploy/traffic-tug.service
sudo cp deploy/traffic-tug.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now traffic-tug
journalctl -u traffic-tug -f
```

啟動訊息會顯示 `metric=nic`(讀網卡)或 `metric=app`(找不到網卡,改用估算)。正式展示必須是 `nic`,否則請確認 `IFACE`。

更新程式:`git pull && sudo systemctl restart traffic-tug`。正式展示前請固定一個已測試的版本。

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `TEAM` | A | 本台隊伍,A 或 B |
| `PORT` | 8100 | 監聽埠 |
| `IFACE` | ens33 | 讀取計數器的網卡 |
| `METRIC_SOURCE` | nic | `nic` 網卡實測;`app` 應用層估算(只給本機測試) |
| `PUBLIC_URL_A` / `PUBLIC_URL_B` | - | 兩隊公開網址,兩台設定相同 |
| `JOIN_URL` | 空 | QR Code 網址,空白則用 `PUBLIC_URL_A` |
| `ADMIN_TOKEN` | - | 管理密碼,未設定時管理功能全部拒絕 |
| `ALERT_TOKEN` | - | Zabbix 告警通知密碼(選配) |
| `TRUST_CF_CONNECTING_IP` | true | 以 `CF-Connecting-IP` 當來源 IP |
| `PER_IP_MAX_RPS` | 0 | 每 IP 每秒上限,0 為不限(校園網路常共用 IP) |
| `TUG_*`、`HEIST_*`、`MAX_*` | 見 `.env.example` | 遊戲參數,管理頁可即時調整 |

## 網址

| 路徑 | 用途 | 權限 |
|---|---|---|
| `/` | 選隊頁(QR Code 指向這裡) | 公開 |
| `/play?team=A` | 玩家頁:大廳 + 遊戲 | 公開 |
| `/board` | 投影比分頁 | 公開唯讀 |
| `/admin` | 主持人控制台 | 頁面公開,操作需 `ADMIN_TOKEN` |
| `/events` | 即時狀態(SSE) | 公開唯讀 |
| `/stats` | 統計 JSON,給 Zabbix HTTP agent | 公開唯讀 |
| `/api/tap?game=tug\|heist` | 玩家點擊(POST) | 公開,有限速 |
| `/api/admin/{select,start,stop,reveal,reset,params}` | 管理操作(POST) | `Authorization: Bearer <ADMIN_TOKEN>` |
| `/api/alert` | 接收 Zabbix 告警(POST) | `Authorization: Bearer <ALERT_TOKEN>` |
| `/healthz` | 健康檢查 | 公開 |

## 偷鑽石的人數調整

兩隊套用同一套標準,依各自人數換算:

1. 按下開始時鎖定各隊人數,以 `HEIST_GROUP_SIZE`(預設 5)人為一級:1–5 人 1 級、6–10 人 2 級,以此類推。
2. 倒數 3 秒期間玩家還不能點擊,程式量測此時的網卡流量作為**背景流量**(即時畫面推送、監控查詢等)。
3. 門檻 = 背景流量 + `HEIST_ALLOW_PER_GROUP_MBPS` × 級數。
4. 終點 = `HEIST_GOAL_PER_GROUP_MB` × 級數;小偷前進量只計算扣掉背景流量後的部分。
5. 時間到都沒人偷到時,比較完成百分比(人數不同時終點不同)。

範例(預設值、背景 0.4 Mbps):12 人的隊伍算 3 級 → 門檻 1.3 Mbps、終點 3.6 MB;8 人的隊伍算 2 級 → 門檻 1.0 Mbps、終點 2.4 MB。

## 流量控制

整個遊戲目標低於 10 Mbps。預設值的估算(每隊 30 人都全速點擊):

| 情境 | 每台請求數 | 估計流量 |
|---|---|---|
| 拔河 A 隊:6 KB × 每人每秒 2 次 | 60 req/s | 約 3 Mbps |
| 拔河 B 隊:16 B × 4 連發 × 每人每秒 2 次 | 240 req/s | 約 1.5 Mbps(多為標頭) |
| 偷鑽石:4 KB × 每人每秒 3 次 | 90 req/s | 約 3 Mbps(30 人門檻約背景 + 1.8,全速會被抓) |
| 即時畫面推送:每支手機每秒約 0.7 KB × 2 台 | - | 每台約 0.35 Mbps |

保護機制(都可在管理頁調整):

1. 手機端:依 `*_TAPS_PER_SEC` 限制點擊節奏,太快會提示「照節奏點」。
2. 伺服器端:每位玩家的令牌桶(上限 × 1.3)、只接受已連上 `/events` 的玩家代碼。
3. 每台 VM:`MAX_RPS` 請求上限、`MAX_MBPS` 應用層流量上限,超過回應 429。

回應內容是隨機位元組並帶 `Cache-Control: no-store, no-transform`,避免 Cloudflare 快取或壓縮,實際傳輸量才會接近設定值。

## `/stats` 欄位

```json
{
  "team": "A", "game": "tug", "phase": "running", "round_active": true, "players": 28,
  "total_requests": 12580, "requests_per_second": 92.4, "rejected_requests": 3,
  "application_bytes_received": 0, "application_bytes_sent": 21000000,
  "metric_source": "nic", "live_mbps": 2.84, "live_pps": 512,
  "round_bytes": 9800000, "round_packets": 14200,
  "heist_noise_mbps": 0.0, "heist_threshold_mbps": 1.3, "heist_baseline_mbps": 0.4,
  "heist_groups": 3, "heist_progress_bytes": 0, "heist_caught": 0, "heist_escaped": 0, "zabbix_alert": 0,
  "nic": {"iface": "ens33", "rx_bytes": 0, "tx_bytes": 0, "rx_packets": 0, "tx_packets": 0},
  "uptime_sec": 3600
}
```

| 欄位 | 意義 |
|---|---|
| `total_requests`、`requests_per_second` | 成功處理的點擊請求數、近 5 秒平均每秒請求數 |
| `rejected_requests` | 被限速或回合外拒絕的請求數 |
| `application_bytes_*` | 應用層資料量(程式自己統計,**不是**網卡傳輸量) |
| `live_mbps`、`live_pps` | 最近 1 秒網卡(收+送)Mbps、封包數 |
| `round_bytes`、`round_packets` | 本回合網卡累計 Bytes、Packets(即遊戲比分) |
| `heist_noise_mbps` | 偷鑽石的噪音值:最近 2 秒平均 Mbps |
| `heist_threshold_mbps`、`heist_baseline_mbps`、`heist_groups` | 本回合門檻、背景流量、人數級數 |
| `heist_progress_bytes` | 扣掉背景後的前進量 |
| `heist_caught` / `heist_escaped` | 是否被偵測 / 是否偷到鑽石(0 或 1) |
| `zabbix_alert` | 目前是否有 Zabbix 告警(0 或 1) |
| `nic` | 網卡累計計數器原始值 |

## Zabbix 設定建議

**1. HTTP agent 主項目**(每台遊戲 VM 各一個)
Type:HTTP agent、URL:`http://<VM 內部 IP>:8100/stats`、Type of information:Text、Update interval:`10s`、History:`1d`。

**2. 相依項目**(Type:Dependent item,Preprocessing → JSONPath)

| 名稱 | JSONPath | 單位 |
|---|---|---|
| 遊戲每秒請求數 | `$.requests_per_second` | req/s |
| 遊戲即時流量 | `$.live_mbps`,再乘 1000000 | bps |
| 遊戲即時封包 | `$.live_pps` | pps |
| 偷鑽石噪音 | `$.heist_noise_mbps` | Mbps |
| 偷鑽石被偵測 | `$.heist_caught` | - |

**3. agent 網卡項目**:`net.if.in["ens33"]`、`net.if.out["ens33"]`、`net.if.in["ens33",packets]`、`net.if.out["ens33",packets]`,Update interval 改 `10s`(packets 項目需在 Preprocessing 加 Change per second)。

**4. 偷鑽石 Trigger 範例**:`last(/Game-Server-A/heist.caught)=1` 或 `avg(/Game-Server-A/net.if.out["ens33"],20s)>1.5M`。
遊戲本身每秒判定、立即在畫面顯示;Zabbix 每 10 秒取樣,作為正式告警紀錄。

## Zabbix 告警連動畫面(選配)

觸發時投影頁頂端會出現紅色「Zabbix 告警」橫幅。

```bash
curl -X POST http://<VM IP>:8100/api/alert \
  -H "Authorization: Bearer <ALERT_TOKEN>" -H "Content-Type: application/json" \
  -d '{"status":"PROBLEM","name":"A 隊流量過高"}'
# 解除:{"status":"OK"}
```

在 Zabbix 建一個 Webhook Media type,參數 `url`、`token`、`status`(`{EVENT.VALUE}` 轉為 PROBLEM/OK)、`name`(`{EVENT.NAME}`),Script:

```javascript
var p = JSON.parse(value);
var req = new HttpRequest();
req.addHeader('Content-Type: application/json');
req.addHeader('Authorization: Bearer ' + p.token);
req.post(p.url, JSON.stringify({ status: p.status === '1' ? 'PROBLEM' : 'OK', name: p.name }));
return 'OK';
```

## 本機測試(不需 VM)

同一台電腦開兩個實例模擬 A、B。因為兩個實例共用網卡,改用 `METRIC_SOURCE=app` 估算模式:

```bash
export METRIC_SOURCE=app ADMIN_TOKEN=test PUBLIC_URL_A=http://127.0.0.1:8100 PUBLIC_URL_B=http://127.0.0.1:8101
TEAM=A PORT=8100 python3 -m app &
TEAM=B PORT=8101 python3 -m app &
python3 scripts/loadtest.py --a http://127.0.0.1:8100 --b http://127.0.0.1:8101 --players 15
```

瀏覽器打開 `http://127.0.0.1:8100/admin`(密碼 test)、`/board`、手機模擬 `/`,在管理頁選遊戲並開始。

## 負載測試 / 錄影備案

`scripts/loadtest.py` 只用 Python 標準函式庫,可在任何電腦執行,模擬每隊 N 位玩家:

```bash
python3 scripts/loadtest.py --a https://tug-a.example.com --b https://tug-b.example.com --players 30
# 偷鑽石時 A 隊全速、B 隊半速(預設),可用 --heist-ratio-a / --heist-ratio-b 調整
# 兩隊人數不同:--players-a 12 --players-b 8
```

## 展示當天流程

1. 投影開 `/board`,主持人另開 `/admin` 並輸入密碼。
2. 請觀眾掃 QR Code,依座位選 A、B 隊,投影看人數。
3. 管理頁「選擇:流量拔河」→「開始」→ 30 秒後先公布流量結果 → 按「拔河反轉」公布封包數。
4. 「選擇:偷鑽石」→「開始」→ 45 秒內看誰先偷到或誰被偵測。
5. 每回合結束切到 Zabbix Dashboard、ntopng 解說同一段時間的數據。
