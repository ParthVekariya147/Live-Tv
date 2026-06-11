#!/bin/bash
PM2="/Users/yashmadhavtech/.nvm/versions/node/v20.19.4/bin/pm2"
"$PM2" stop smk-api smk-controller
echo "SMK TV services stopped."
