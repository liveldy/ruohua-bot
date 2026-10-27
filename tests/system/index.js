/**
 * 目录入口：让 `node --test tests/system` 这种写法也能跑。
 * 原因见 tests/security/index.js 的说明。
 *
 * 常规写法（等价、无需本文件）：node --test "tests/system/*.test.js"
 */

import './selfcheck.test.js';
import './status.test.js';
