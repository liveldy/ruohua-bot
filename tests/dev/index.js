/**
 * 让 `node --test tests/dev` 这条命令可用。
 *
 * Node ≥ 22 的测试运行器改成了「位置参数按 glob 处理」，不再接受目录：
 * 直接 `node --test tests/dev` 会把目录当成一个测试文件去 require，报
 * `Cannot find module '...\tests\dev'`。给目录一个 index.js 之后，
 * 入口解析会落到本文件，再在这里导入同目录下的测试文件。
 *
 * 常规写法（等价、无需本文件）：
 *   node --test "tests/dev/*.test.js"
 */

import './mock-onebot.test.js';
import './mock-llm.test.js';
