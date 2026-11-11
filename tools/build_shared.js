#!/usr/bin/env node
/**
 * 把 shared/ 下的多文件算法模块打包成「单文件 CommonJS 模块」。
 *
 * 为什么需要：H5 预览只有一个加载器（preview.js 的 loadCommonJs），一次只能 eval 一个
 * 文件；微信小程序虽然支持 require，但我们希望两端跑同一份文件、字节一致、便于校验。
 *
 * 产物：shared/bundle.js（默认）与 miniprogram/shared/planner.js（--sync 时同步）
 * 用法：
 *   node tools/build_shared.js              # 生成 shared/bundle.js
 *   node tools/build_shared.js --sync       # 同时覆盖 miniprogram/shared/planner.js
 *   node tools/build_shared.js --check      # 只校验两份是否一致（不写文件），不一致 exit 1
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var SHARED = path.join(ROOT, 'shared');
var OUT = path.join(SHARED, 'bundle.js');
var MIRROR = path.join(ROOT, 'miniprogram', 'shared', 'planner.js');

var ORDER = ['forecast', 'walking', 'scoring', 'planner'];

function readModule(name) {
  return fs.readFileSync(path.join(SHARED, name + '.js'), 'utf8');
}

function build() {
  var parts = [];
  parts.push('/* 自动生成，请勿直接修改：node tools/build_shared.js');
  parts.push(' * 源码在 shared/{forecast,walking,scoring,planner}.js，本文件是它们的单文件打包。');
  parts.push(' */'); // 注意：不要写生成时间，否则 --check 永远不一致
  parts.push("'use strict';");
  parts.push('var __modules = {};');
  parts.push('var __cache = {};');
  parts.push('function __define(name, fn) { __modules[name] = fn; }');
  parts.push('function __require(name) {');
  parts.push("  if (__cache[name]) return __cache[name].exports;");
  parts.push("  if (!__modules[name]) throw new Error('module not found: ' + name);");
  parts.push('  var module = { exports: {} };');
  parts.push('  __cache[name] = module;');
  parts.push('  __modules[name](__require, module, module.exports);');
  parts.push('  return module.exports;');
  parts.push('}');

  ORDER.forEach(function (name) {
    var src = readModule(name);
    // 模块内部的相对 require 换成注册表名字
    src = src.replace(/require\(\s*['"]\.\/([a-zA-Z0-9_]+)\.js['"]\s*\)/g, "__require('$1')");
    src = src.replace(/require\(\s*['"]\.\/([a-zA-Z0-9_]+)['"]\s*\)/g, "__require('$1')");
    if (/\brequire\(/.test(src)) {
      throw new Error(name + '.js 里还有无法打包的 require：\n' + src.match(/require\([^\n]*/g).join('\n'));
    }
    parts.push('');
    parts.push('__define(' + JSON.stringify(name) + ', function (require, module, exports) {');
    parts.push(src);
    parts.push('});');
  });

  parts.push('');
  parts.push("module.exports = __require('planner');");
  parts.push('');
  return parts.join('\n');
}

function main() {
  var args = process.argv.slice(2);
  var sync = args.indexOf('--sync') >= 0;
  var check = args.indexOf('--check') >= 0;
  var code = build();

  if (check) {
    var out = fs.readFileSync(OUT, 'utf8');
    var mirror = fs.readFileSync(MIRROR, 'utf8');
    var ok = out === code && mirror === code;
    console.log(ok ? 'bundle 一致（shared/bundle.js 与 miniprogram/shared/planner.js）' : 'bundle 不一致，请运行 node tools/build_shared.js --sync');
    process.exit(ok ? 0 : 1);
  }

  fs.writeFileSync(OUT, code);
  console.log('wrote ' + path.relative(ROOT, OUT) + ' (' + Buffer.byteLength(code) + ' bytes, modules: ' + ORDER.join(',') + ')');
  if (sync) {
    fs.writeFileSync(MIRROR, code);
    console.log('wrote ' + path.relative(ROOT, MIRROR));
  }
}

main();
