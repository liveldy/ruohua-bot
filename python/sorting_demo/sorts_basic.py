#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
基础排序算法 5 种：冒泡、选择、插入、希尔、归并

约定：每个函数接收任意序列，返回一个升序的新 list，不修改入参。
"""

from __future__ import annotations

from typing import List, Sequence


def bubble_sort(seq: Sequence) -> List:
    """冒泡排序：相邻两两比较，大的往后冒；本轮无交换则提前结束。

    最好 O(n)（已有序），最坏/平均 O(n^2)；空间 O(1)；稳定。
    """
    a = list(seq)
    n = len(a)
    for i in range(n - 1):
        swapped = False
        # 每轮结束后，末尾 i+1 个元素已经就位
        for j in range(n - 1 - i):
            if a[j] > a[j + 1]:
                a[j], a[j + 1] = a[j + 1], a[j]
                swapped = True
        if not swapped:
            break
    return a


def selection_sort(seq: Sequence) -> List:
    """选择排序：每轮从无序区间挑最小值，换到无序区间首位。

    比较次数恒为 O(n^2)；交换至多 n-1 次；空间 O(1)；不稳定。
    """
    a = list(seq)
    n = len(a)
    for i in range(n - 1):
        min_idx = i
        for j in range(i + 1, n):
            if a[j] < a[min_idx]:
                min_idx = j
        if min_idx != i:
            a[i], a[min_idx] = a[min_idx], a[i]
    return a


def insertion_sort(seq: Sequence) -> List:
    """插入排序：把当前元素插进前面已排好序的部分（像摸扑克牌）。

    最好 O(n)，最坏/平均 O(n^2)；空间 O(1)；稳定。
    """
    a = list(seq)
    for i in range(1, len(a)):
        key = a[i]
        j = i - 1
        while j >= 0 and a[j] > key:
            a[j + 1] = a[j]
            j -= 1
        a[j + 1] = key
    return a


def shell_sort(seq: Sequence) -> List:
    """希尔排序：按 Knuth 增量序列 1,4,13,40,... 分组做插入排序。

    复杂度依赖增量序列，Knuth 序列下约 O(n^1.5)；空间 O(1)；不稳定。
    """
    a = list(seq)
    n = len(a)
    gap = 1
    while gap < n // 3:
        gap = gap * 3 + 1
    while gap >= 1:
        for i in range(gap, n):
            key = a[i]
            j = i - gap
            while j >= 0 and a[j] > key:
                a[j + gap] = a[j]
                j -= gap
            a[j + gap] = key
        gap //= 3
    return a


def merge_sort(seq: Sequence) -> List:
    """归并排序：递归二分 + 合并两个有序段（自顶向下）。

    任何情况 O(n log n)；额外空间 O(n)；稳定。
    """
    a = list(seq)

    def _sort(left: int, right: int) -> None:  # 处理区间 [left, right)
        if right - left <= 1:
            return
        mid = (left + right) // 2
        _sort(left, mid)
        _sort(mid, right)
        if a[mid - 1] <= a[mid]:  # 两段已天然有序，跳过合并
            return
        buf = a[left:mid]  # 只缓存左半段
        i, j, k = 0, mid, left
        while i < len(buf) and j < right:
            if buf[i] <= a[j]:
                a[k] = buf[i]
                i += 1
            else:
                a[k] = a[j]
                j += 1
            k += 1
        while i < len(buf):
            a[k] = buf[i]
            i += 1
            k += 1

    _sort(0, len(a))
    return a
