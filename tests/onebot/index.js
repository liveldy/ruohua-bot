/**
 * 目录入口：让 `node --test tests/onebot` 这种写法也能跑。
 * 原因见 tests/security/index.js 的说明。
 *
 * 常规写法（等价、无需本文件）：node --test "tests/onebot/*.test.js"
 */

import './quoting.test.js';
import './logging.test.js';
