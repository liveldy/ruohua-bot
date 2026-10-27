/** 通用小工具：延时、随机、id。 */

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms | 0)));
}

/** 在 [min, max] 毫秒之间随机睡一会儿。 */
export function sleepRandom(range = [300, 1200], rng = Math.random) {
  const [min, max] = range;
  const span = Math.max(0, max - min);
  return sleep(min + Math.floor(rng() * span));
}

export function shortId(prefix = '') {
  const rand = Math.random().toString(36).slice(2, 8);
  const stamp = Date.now().toString(36).slice(-4);
  return `${prefix ? `${prefix}_` : ''}${stamp}${rand}`;
}

/** 从数组中按权重挑一个元素；权重为空时等概率。 */
export function pickWeighted(items, weights = null, rng = Math.random) {
  if (!items?.length) return null;
  if (!weights) return items[Math.floor(rng() * items.length)];
  const list = items.map((item) => Number(weights[item] ?? weights[String(item)] ?? 1));
  const total = list.reduce((sum, w) => sum + (w > 0 ? w : 0), 0);
  if (total <= 0) return items[0];
  let roll = rng() * total;
  for (let i = 0; i < items.length; i += 1) {
    roll -= list[i] > 0 ? list[i] : 0;
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

export function randomInt(min, max, rng = Math.random) {
  return min + Math.floor(rng() * Math.max(1, max - min + 1));
}

/** 把 rng 换成种子随机，测试里可复现。 */
export function seededRandom(seed = 1) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 路由用的简单事件总线：支持 once / on / off / emit。 */
export class EventBus {
  #handlers = new Map();

  on(name, handler) {
    const list = this.#handlers.get(name) ?? [];
    list.push({ handler, once: false });
    this.#handlers.set(name, list);
    return () => this.off(name, handler);
  }

  once(name, handler) {
    const list = this.#handlers.get(name) ?? [];
    list.push({ handler, once: true });
    this.#handlers.set(name, list);
  }

  off(name, handler) {
    const list = this.#handlers.get(name);
    if (!list) return;
    this.#handlers.set(
      name,
      list.filter((item) => item.handler !== handler),
    );
  }

  async emit(name, payload) {
    const list = [...(this.#handlers.get(name) ?? [])];
    const results = [];
    for (const item of list) {
      if (item.once) this.off(name, item.handler);
      try {
        results.push(await item.handler(payload));
      } catch (error) {
        results.push(error);
      }
    }
    return results;
  }
}
