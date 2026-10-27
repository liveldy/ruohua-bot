/**
 * 目录入口：让 `node --test tests/perception` 这种写法也能跑（Node 24 不再把目录参数
 * 自动展开成测试文件列表）。单独跑一个文件时不受影响。
 */

import './sidecar.test.js';
import './vision.test.js';
import './screen.test.js';
import './sidecar-python.test.js';
