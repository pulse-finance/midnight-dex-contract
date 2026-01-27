#!/bin/bash
cp -rt ../pulse-finance-dex-app/node_modules/@pulsefinance/dex-contract/dist ./dist/*

pnpm -C ../pulse-finance-dex-app run copy:circuits
