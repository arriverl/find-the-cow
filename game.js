/** 每关在 4～13 之间随机一个 n，作为本关的 n×n 格子大小 */
function getRandomGridSize() {
    return 4 + Math.floor(Math.random() * 10); // 4..13
}

let gridSize = 5;           // 当前 n×n 的 n
let currentLevel = 1;      // 当前关卡
let lives = 3;              // 当前关剩余命数
let boardData = [];         // 存储单元格信息
let gameOver = false;       // 是否已游戏结束（命用尽）
const DOUBLE_CLICK_DELAY = 280;  // 毫秒内第二次点击视为双击
const LONG_PRESS_MS = 400;       // 长按超过此时间进入「连续标×」模式
let clickPending = null;   // { r, c, timeoutId } 用于区分单击/双击
let uiUpdateScheduled = false;   // 用于合并 updateUI/checkWin，减少卡顿
let longPressTimer = null;      // 长按定时器
let longPressDrawing = false;   // 是否处于长按拖拽标×
let longPressTouchId = null;    // 当前长按的 touch identifier
let longPressMouse = false;     // 是否鼠标长按

function initGame() {
    gameOver = false;
    currentLevel = 1;
    lives = 3;
    startLevel(currentLevel);
}

/** 开始指定关卡（或从第一关重新开始） */
function startLevel(level) {
    currentLevel = level;
    gridSize = getRandomGridSize();
    lives = 3;
    gameOver = false;

    const boardEl = document.getElementById('game-board');
    const statusEl = document.getElementById('status');
    statusEl.classList.remove('win', 'lose');

    boardEl.style.gridTemplateColumns = `repeat(${gridSize}, 1fr)`;
    boardEl.innerHTML = '';
    boardData = Array.from({ length: gridSize }, () => Array(gridSize).fill(null));

    // 生成唯一解地图：若解不唯一则丢弃重生成
    const UNIQUE_MAX_ATTEMPTS = 100;
    let seeds = null;
    let regions = null;
    let hasUnique = false;
    for (let attempt = 0; attempt < UNIQUE_MAX_ATTEMPTS; attempt++) {
        seeds = generateCowSeeds();
        if (!seeds || seeds.length !== gridSize) continue;
        regions = generateRegions(seeds);
        if (countSolutions(regions) === 1) {
            hasUnique = true;
            break;
        }
    }
    if (!hasUnique || !seeds || !regions) {
        statusEl.textContent = '生成唯一解地图失败，请点击重新开始';
        return;
    }

    for (let r = 0; r < gridSize; r++) {
        for (let c = 0; c < gridSize; c++) {
            const cell = document.createElement('div');
            cell.className = `cell region-${regions[r][c] % 8}`;
            cell.dataset.r = r;
            cell.dataset.c = c;
            cell.addEventListener('click', handleCellClick);
            boardEl.appendChild(cell);

            boardData[r][c] = {
                region: regions[r][c],
                isCow: false,
                isMark: false,
                correctCow: seeds.some(s => s.r === r && s.c === c),
                el: cell
            };
        }
    }

    // 长按拖拽标×：触摸与鼠标
    boardEl.addEventListener('touchstart', handlePointerDown, { passive: true });
    boardEl.addEventListener('mousedown', handlePointerDown);

    updateUI();
}

function generateCowSeeds() {
    const n = gridSize;
    const maxAttempts = 5000;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const seeds = [];
        const colsUsed = new Set();

        for (let r = 0; r < n; r++) {
            const possibleCols = [];
            for (let c = 0; c < n; c++) {
                if (colsUsed.has(c)) continue;
                if (!isNearAnySeed(r, c, seeds)) possibleCols.push(c);
            }
            if (possibleCols.length === 0) break;

            const chosenCol = possibleCols[Math.floor(Math.random() * possibleCols.length)];
            seeds.push({ r, c: chosenCol });
            colsUsed.add(chosenCol);
        }

        if (seeds.length === n) return seeds;
    }
    return null;
}

function isNearAnySeed(r, c, seeds) {
    return seeds.some(s => Math.abs(s.r - r) <= 1 && Math.abs(s.c - c) <= 1);
}

function generateRegions(seeds) {
    const n = gridSize;
    const grid = Array.from({ length: n }, () => Array(n).fill(-1));
    const queue = [];

    seeds.forEach((s, id) => {
        grid[s.r][s.c] = id;
        queue.push({ r: s.r, c: s.c, id });
    });

    const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];

    while (queue.length > 0) {
        const idx = Math.floor(Math.random() * queue.length);
        const { r, c, id } = queue.splice(idx, 1)[0];

        const shuffled = [...dirs].sort(() => Math.random() - 0.5);
        for (const [dr, dc] of shuffled) {
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < n && nc >= 0 && nc < n && grid[nr][nc] === -1) {
                grid[nr][nc] = id;
                queue.push({ r: nr, c: nc, id });
            }
        }
    }
    return grid;
}

/** 合并到下一帧执行，减少快速连续点击时的卡顿 */
function scheduleUIUpdate() {
    if (uiUpdateScheduled) return;
    uiUpdateScheduled = true;
    requestAnimationFrame(() => {
        updateUI();
        checkWin();
        uiUpdateScheduled = false;
    });
}

/** 仅将格子设为 ×（用于长按拖拽），不取消牛、不切换空白 */
function setCellMarkOnly(r, c) {
    if (r < 0 || r >= gridSize || c < 0 || c >= gridSize) return;
    const cell = boardData[r][c];
    const el = cell.el;
    if (cell.isCow) return; // 已是牛不改为×
    if (cell.isMark) return; // 已是×不重复操作
    cell.isMark = true;
    el.classList.add('mark');
    if (window.navigator.vibrate) window.navigator.vibrate(30);
}

/** 长按开始：触摸 */
function handlePointerDown(e) {
    if (gameOver) return;
    const isTouch = e.type === 'touchstart';
    const target = e.target;
    if (!target.classList || !target.classList.contains('cell')) return;
    const r = parseInt(target.dataset.r, 10);
    const c = parseInt(target.dataset.c, 10);

    const touchId = isTouch ? e.changedTouches[0].identifier : null;

    const startLongPressDraw = () => {
        longPressDrawing = true;
        if (clickPending && clickPending.r === r && clickPending.c === c) {
            clearTimeout(clickPending.timeoutId);
            clickPending = null;
        }
        setCellMarkOnly(r, c);
        scheduleUIUpdate();

        const onMove = (e2) => {
            if (!longPressDrawing) return;
            let x, y;
            if (e2.type.startsWith('touch')) {
                const t = Array.from(e2.touches).find(touch => touch.identifier === longPressTouchId)
                    || (e2.changedTouches && e2.changedTouches[0]);
                if (!t) return;
                x = t.clientX;
                y = t.clientY;
                e2.preventDefault();
            } else {
                x = e2.clientX;
                y = e2.clientY;
            }
            const el = document.elementFromPoint(x, y);
            if (el && el.dataset && el.dataset.r !== undefined) {
                const nr = parseInt(el.dataset.r, 10);
                const nc = parseInt(el.dataset.c, 10);
                setCellMarkOnly(nr, nc);
            }
        };

        const onEnd = (e2) => {
            longPressDrawing = false;
            longPressTouchId = null;
            longPressMouse = false;
            document.removeEventListener('touchmove', onMove, { capture: true });
            document.removeEventListener('touchend', onEnd, { capture: true });
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            if (e2.type.startsWith('touch')) e2.preventDefault(); // 阻止合成 click
            scheduleUIUpdate();
        };

        if (isTouch) {
            longPressTouchId = touchId;
            document.addEventListener('touchmove', onMove, { passive: false, capture: true });
            document.addEventListener('touchend', onEnd, { capture: true });
        } else {
            longPressMouse = true;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onEnd);
        }
    };

    if (isTouch) {
        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            startLongPressDraw();
        }, LONG_PRESS_MS);
    } else {
        if (e.button !== 0) return;
        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            startLongPressDraw();
        }, LONG_PRESS_MS);
    }
}

/** 触摸结束 / 鼠标松开时若未进入长按则清除定时器，并允许正常 click */
function handlePointerUp(e) {
    if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
    }
}

// 在 document 上监听，确保手指/鼠标在别处松开也能清除定时器
document.addEventListener('touchend', handlePointerUp, { capture: true });
document.addEventListener('touchcancel', handlePointerUp, { capture: true });
document.addEventListener('mouseup', handlePointerUp);

/** 统计当前区域图有多少组合法解（每区选一格，每行每列各一，8 邻不相邻） */
function countSolutions(regions) {
    const n = regions.length;
    const regionCells = Array.from({ length: n }, () => []);
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            const id = regions[r][c];
            if (id >= 0 && id < n) regionCells[id].push({ r, c });
        }
    }

    const usedRow = new Set();
    const usedCol = new Set();
    const chosen = [];
    let count = 0;

    function adjacent(a, b) {
        return Math.abs(a.r - b.r) <= 1 && Math.abs(a.c - b.c) <= 1;
    }

    function backtrack(regionIdx) {
        if (count > 1) return;
        if (regionIdx === n) {
            count++;
            return;
        }
        for (const cell of regionCells[regionIdx]) {
            if (usedRow.has(cell.r) || usedCol.has(cell.c)) continue;
            let ok = true;
            for (let i = 0; i < chosen.length; i++) {
                if (adjacent(cell, chosen[i])) {
                    ok = false;
                    break;
                }
            }
            if (!ok) continue;
            usedRow.add(cell.r);
            usedCol.add(cell.c);
            chosen.push(cell);
            backtrack(regionIdx + 1);
            chosen.pop();
            usedCol.delete(cell.c);
            usedRow.delete(cell.r);
        }
    }

    backtrack(0);
    return count;
}

/** 单击：空白↔×；连续双击：标为牛（标错扣命） */
function handleCellClick(e) {
    if (gameOver) return;

    if (window.navigator.vibrate) {
        window.navigator.vibrate(50); // 轻轻震动 50ms，手机手感反馈
    }

    const r = parseInt(e.currentTarget.dataset.r, 10);
    const c = parseInt(e.currentTarget.dataset.c, 10);
    const cell = boardData[r][c];
    const el = e.currentTarget;

    // 同一格在延迟内再次点击 → 视为双击 → 标牛
    if (clickPending && clickPending.r === r && clickPending.c === c) {
        clearTimeout(clickPending.timeoutId);
        clickPending = null;
        applyMarkAsCow(cell, el);
        return;
    }

    if (clickPending) {
        clearTimeout(clickPending.timeoutId);
        clickPending = null;
    }

    clickPending = {
        r, c,
        timeoutId: setTimeout(() => {
            clickPending = null;
            // 单击：空白 → ×，× → 空白；若已是牛则单击取消为空白
            if (cell.isCow) {
                cell.isCow = false;
                el.classList.remove('cow');
            } else if (cell.isMark) {
                cell.isMark = false;
                el.classList.remove('mark');
            } else {
                cell.isMark = true;
                el.classList.add('mark');
            }
            document.querySelectorAll('.cell.error').forEach(n => n.classList.remove('error'));
            scheduleUIUpdate();
        }, DOUBLE_CLICK_DELAY)
    };
}

/** 将格子标为牛；若位置错误则扣命并恢复为 × */
function applyMarkAsCow(cell, el) {
    if (cell.isCow) {
        cell.isCow = false;
        el.classList.remove('cow');
        scheduleUIUpdate();
        return;
    }

    cell.isMark = false;
    cell.isCow = true;
    el.classList.remove('mark');
    el.classList.add('cow');

    if (!cell.correctCow) {
        lives--;
        el.classList.add('error');
        setTimeout(() => {
            cell.isCow = false;
            cell.isMark = true;
            el.classList.remove('cow', 'error');
            el.classList.add('mark');
            scheduleUIUpdate();
        }, 400);
        scheduleUIUpdate();
        if (lives <= 0) {
            gameOver = true;
            const statusEl = document.getElementById('status');
            statusEl.textContent = '游戏结束！命已用尽。点击「重新开始」从第一关再玩。';
            statusEl.classList.add('lose');
        }
        return;
    }

    document.querySelectorAll('.cell.error').forEach(n => n.classList.remove('error'));
    scheduleUIUpdate();
}

function updateUI() {
    const statusEl = document.getElementById('status');
    const levelEl = document.getElementById('level');
    const livesEl = document.getElementById('lives');

    if (levelEl) levelEl.textContent = `第 ${currentLevel} 关 · ${gridSize}×${gridSize}`;
    if (livesEl) livesEl.textContent = '❤️'.repeat(lives) + '♡'.repeat(3 - lives);

    if (gameOver) return;

    const correctCows = countCorrectCows();
    const remaining = gridSize - correctCows;
    if (remaining > 0 && statusEl && !statusEl.classList.contains('win')) {
        statusEl.textContent = `剩余小牛: ${remaining} · 单击×/取消×，双击标牛`;
    }
}

function countCorrectCows() {
    let n = 0;
    for (let r = 0; r < gridSize; r++) {
        for (let c = 0; c < gridSize; c++) {
            if (boardData[r][c].isCow && boardData[r][c].correctCow) n++;
        }
    }
    return n;
}

function checkWin() {
    if (gameOver) return;

    const correctCows = countCorrectCows();
    if (correctCows !== gridSize) return;

    const statusEl = document.getElementById('status');
    statusEl.textContent = `🎉 第 ${currentLevel} 关通过！即将进入下一关…`;
    statusEl.classList.add('win');

    setTimeout(() => {
        startLevel(currentLevel + 1);
    }, 1200);
}

// 页面加载时从第一关开始
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGame);
} else {
    initGame();
}
