#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
进阶排序算法 5 种：快速、堆、计数、基数、桶

约定：每个函数接收任意序列，返回一个升序的新 list，不修改入参。
"""

from __future__ import annotations

from typing import List, Sequence


def quick_sort(seq: Sequence) -> List:
    """快速排序：三数取中 pivot + Hoare 分区 + 小区间插入排序 + 先递归短边。

    平均 O(n log n)，最坏 O(n^2)（三数取中已大幅缓解最坏情况）；原地；不稳定。
    """
    a = list(seq)
    THRESHOLD = 16

    def _insertion(left: int, right: int) -> None:  # 区间 [left, right)
        for i in range(left + 1, right):
            key = a[i]
            j = i - 1
            while j >= left and a[j] > key:
                a[j + 1] = a[j]
                j -= 1
            a[j + 1] = key

    def _median3(lo: int, hi: int):
        mid = (lo + hi) // 2
        if a[mid] < a[lo]:
            a[mid], a[lo] = a[lo], a[mid]
        if a[hi] < a[lo]:
            a[hi], a[lo] = a[lo], a[hi]
        if a[hi] < a[mid]:
            a[hi], a[mid] = a[mid], a[hi]
        return a[mid]

    def _sort(lo: int, hi: int) -> None:  # 闭区间 [lo, hi]
        while hi - lo + 1 > THRESHOLD:
            pivot = _median3(lo, hi)
            i, j = lo, hi
            while i <= j:  # Hoare 式分区
                while a[i] < pivot:
                    i += 1
                while a[j] > pivot:
                    j -= 1
                if i <= j:
                    a[i], a[j] = a[j], a[i]
                    i += 1
                    j -= 1
            # 先递归较短的一边，保证递归栈深度 O(log n)
            if j - lo < hi - i:
                _sort(lo, j)
                lo = i
            else:
                _sort(i, hi)
                hi = j
        _insertion(lo, hi + 1)

    if a:
        _sort(0, len(a) - 1)
    return a


def heap_sort(seq: Sequence) -> List:
    """堆排序：建大顶堆 -> 堆顶换到末尾，堆缩小后下沉调整，得到升序。

    任何情况 O(n log n)；空间 O(1)；不稳定。
    """
    a = list(seq)
    n = len(a)

    def _sift_down(start: int, end: int) -> None:  # 在 [start, end) 上调整
        root = start
        while True:
            child = 2 * root + 1
            if child >= end:
                return
            # 取较大的孩子
            if child + 1 < end and a[child] < a[child + 1]:
                child += 1
            if a[root] < a[child]:
                a[root], a[child] = a[child], a[root]
                root = child
            else:
                return

    # 1) 自底向上建堆
    for start in range(n // 2 - 1, -1, -1):
        _sift_down(start, n)
    # 2) 逐个把堆顶（最大值）换到末尾
    for end in range(n - 1, 0, -1):
        a[0], a[end] = a[end], a[0]
        _sift_down(0, end)
    return a


def counting_sort(seq: Sequence) -> List:
    """计数排序：统计每个值出现次数，再按值顺序回填。支持负数、支持非整数报错。

    时间 O(n + k)，k 为 (最大值-最小值+1)；额外空间 O(n + k)；稳定。
    """
    a = list(seq)
    if not a:
        return []
    lo, hi = min(a), max(a)
    span = hi - lo + 1
    count = [0] * span
    for x in a:
        count[int(x) - lo] += 1
    # 前缀和 -> 每个值的结束位置，保证稳定
    for i in range(1, span):
        count[i] += count[i - 1]
    out = [0] * len(a)
    for x in reversed(a):
        idx = int(x) - lo
        count[idx] -= 1
        out[count[idx]] = x
    return out


def radix_sort(seq: Sequence) -> List:
    """基数排序（LSD，十进制，逐位计数排序）。负数整体平移成非负后再排，结果等价。

    时间 O(d * (n + 10))，d 为最大位数；额外空间 O(n)；稳定。
    """
    a = list(seq)
    if not a:
        return []
    offset = 0
    if min(a) < 0:
        offset = -min(a)
    arr = [int(x) + offset for x in a]

    max_val = max(arr)
    exp = 1
    while max_val // exp > 0:
        buckets = [[] for _ in range(10)]
        for x in arr:
            buckets[(x // exp) % 10].append(x)
        arr = [x for bucket in buckets for x in bucket]
        exp *= 10

    if offset:
        arr = [x - offset for x in arr]
    return arr


def bucket_sort(seq: Sequence) -> List:
    """桶排序：按值域均分 n 个桶，桶内用插入排序，最后按桶顺序拼接。

    平均 O(n + k)，最坏 O(n^2)（数据全落一个桶）；额外空间 O(n + k)；稳定。
    """
    a = list(seq)
    n = len(a)
    if n <= 1:
        return a
    lo, hi = min(a), max(a)
    if lo == hi:
        return a
    bucket_count = n
    width = (hi - lo) / bucket_count
    buckets: List[List] = [[] for _ in range(bucket_count)]
    for x in a:
        idx = int((x - lo) / width)
        if idx == bucket_count:  # 最大值归到最后一个桶
            idx -= 1
        buckets[idx].append(x)

    out: List = []
    for bucket in buckets:
        # 桶内插入排序
        for i in range(1, len(bucket)):
            key = bucket[i]
            j = i - 1
            while j >= 0 and bucket[j] > key:
                bucket[j + 1] = bucket[j]
                j -= 1
            bucket[j + 1] = key
        out.extend(bucket)
    return out
