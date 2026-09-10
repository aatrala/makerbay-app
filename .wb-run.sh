#!/usr/bin/env bash
# Batch-post webbridge request files: ./wb-run.sh req1.json req2.json ...
for f in "$@"; do
  echo "--- $f"
  curl.exe -s -X POST http://127.0.0.1:10086/command -H "Content-Type: application/json" --data-binary "@$f"
  echo
  sleep 1
done
