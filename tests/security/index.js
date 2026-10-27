/**
 * 目录入口：让 `node --test tests/security` 这种写法也能跑。
 *
 * Node ≥ 22 的测试运行器把位置参数当 glob 处理，不再展开目录：直接 `node --test tests/security`
 * 会把目录当成一个测试文件去 require，报 `Cannot find module '...\tests\security'`。
 * 给目录一个 index.js 之后，入口解析落到本文件，再在这里导入同目录的测试文件。
 *
 * 常规写法（等价、无需本文件）：node --test "tests/security/*.test.js"
 */

import './guard.test.js';
import './boundary.test.js';
