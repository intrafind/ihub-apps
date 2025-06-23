sudo systemctl stop kipitz.service

mkdir kipitz-1.7.0 && tar -xzf ai-hub-apps-v1.7.0-linux.tar.gz -C kipitz-1.7.0

mv kipitz kipitz-bak-1.5.0

mv kipitz-1.7.0 kipitz

./copy-over.sh

cd kipitz & ln -sfn ai-hub-apps-v1.x.x-linux ai-hub-apps-linux


sudo systemctl start kipitz.service

sudo systemctl status kipitz.service

sudo systemctl restart kipitz.service

sudo systemctl daemon-reload

sudo nano /etc/systemd/system/kipitz.service

ln -sfn ai-hub-apps-v1.x.x-linux ai-hub-apps-linux


# add symlink for executable