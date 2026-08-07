#!/bin/bash
echo "$ cat node_modules/demo-pkg/package.json"
sleep 1
cat node_modules/demo-pkg/package.json
echo ""
sleep 2
echo "$ npx trace-npm run --package demo-pkg --script postinstall --i-understand-this-executes-untrusted-code"
sleep 1
node bin/trace-npm.js run --package demo-pkg --script postinstall --i-understand-this-executes-untrusted-code
sleep 3
