#!/bin/bash
# 在本機(Mac / Linux)同時啟動 A 隊(8100)與 B 隊(8101),用來試玩與展示。
# 用法:bash scripts/local-test.sh          自動抓本機區網 IP,手機在同一個 Wi-Fi 可加入
#       bash scripts/local-test.sh 127.0.0.1 只在這台電腦上玩
cd "$(dirname "$0")/.." || exit 1

IP="$1"
[ -z "$IP" ] && IP=$(ipconfig getifaddr en0 2>/dev/null)
[ -z "$IP" ] && IP=$(ipconfig getifaddr en1 2>/dev/null)
[ -z "$IP" ] && IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$IP" ] && IP=127.0.0.1

PY=.venv/bin/python
[ -x "$PY" ] || PY=python3

export METRIC_SOURCE=app ENV_FILE=/dev/null
export ADMIN_TOKEN="${ADMIN_TOKEN:-test}" ALERT_TOKEN=test
export PUBLIC_URL_A="http://$IP:8100" PUBLIC_URL_B="http://$IP:8101"

TEAM=A PORT=8100 "$PY" -m app & PA=$!
TEAM=B PORT=8101 "$PY" -m app & PB=$!
trap 'kill $PA $PB 2>/dev/null' EXIT INT TERM
sleep 2

cat <<EOF

================ 本機測試已啟動 ================
 玩家入口(手機掃這個):  http://$IP:8100/
 投影畫面:              http://$IP:8100/board
 主持人控制台:          http://$IP:8100/admin   密碼:$ADMIN_TOKEN
 模擬對手(另開一個終端機分頁執行):
   python3 scripts/loadtest.py --a http://$IP:8100 --b http://$IP:8101 --players 10
 數值為「應用層估算」,真實網卡數據要部署到 VM 才看得到。
 按 Control + C 結束
================================================
EOF
wait
