#!/bin/bash
cp -rt ../dex-app/node_modules/@pulsefinance/dex-contract/dist ./dist/*

pnpm -C ../dex-app run copy:circuits
