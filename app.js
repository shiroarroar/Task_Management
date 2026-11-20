/**
 * TaskFlow 前端核心邏輯 (第一階段：登入、三級權限、Kanban 看板、清單、任務協作)
 */

// 可直接在此填入部署後的 Google Apps Script Web App 網址，或在登入畫面的「設定」中輸入
const DEFAULT_API_URL = 'https://script.google.com/macros/s/AKfycbzKh-I2OCW5OshQQDpBtKeXK0r6F0vXXpz_Qlc5PAPLVa_7IHpTOIFat48U9lrkOsP5/exec';

const STORAGE_KEYS = {
  API_URL: 'taskflow_gas_api_url',
  TOKEN: 'taskflow_session_token',
  TIME_LOGS_CACHE: 'taskflow_timelogs_cache',
  PREDECESSORS_CACHE: 'taskflow_predecessors_cache',
  ACTIVE_TIMER: 'taskflow_active_timer'
};

const VIEW_TITLES = {
  kanban: '看板檢視',
  list: '清單檢視',
  gantt: '甘特圖 / 時間軸',
  dashboard: '主管數據儀表板',
  admin: '帳號管理'
};

const COLUMNS = [
  { key: 'todo', label: '待辦' },
  { key: 'in_progress', label: '進行中' },
  { key: 'review', label: '審核中' },
  { key: 'done', label: '已完成' }
];

const PRIORITY_LABELS = {
  urgent: '🔴 緊急',
  high: '🟠 高',
  medium: '🔵 中',
  low: '⚪ 低'
};

const ROLE_LABELS = {
  admin: '系統管理員',
  manager: '部門主管',
  member: '一般成員'
};

const ALLOWED_FILE_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'csv', 'md', 'png', 'jpg', 'jpeg', 'gif', 'webp',
  'zip', 'rar', '7z'
]);

const VALID_PRIORITIES = new Set(['urgent', 'high', 'medium', 'low']);
const SYNC_INTERVAL_MS = 8000;

function getStoredApiUrl() {
  const saved = (localStorage.getItem(STORAGE_KEYS.API_URL) || '').trim();
  if (saved && isValidGasUrl(saved)) return saved;
  return DEFAULT_API_URL;
}

const state = {
  apiUrl: getStoredApiUrl(),
  token: sessionStorage.getItem(STORAGE_KEYS.TOKEN) || '',
  currentUser: null,
  users: [],
  tasks: [],
  subtasks: [],
  attachments: [],
  comments: [],
  notifications: [],
  timeLogs: [],
  activeView: 'kanban',
  ganttZoom: 'day',
  editingTaskId: null,
  timer: loadSavedTimer(),
  timerInterval: null,
  dataVersion: '',
  syncTimerId: null,
  isSyncing: false
};

// ============================================================================
// API 呼叫層 (使用 text/plain 避免 CORS preflight 失敗)
// ============================================================================
async function callApi(action, payload = {}) {
  const url = state.apiUrl.trim();
  if (!url) {
    throw new Error('尚未設定 Google Apps Script API 網址');
  }
  if (!isValidGasUrl(url)) {
    throw new Error('API 網址格式不合法，僅允許 https://script.google.com/macros/s/... 網址');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      action,
      token: state.token,
      payload
    })
  });
  const data = await res.json();
  if (!data.ok) {
    if (data.code === 'UNAUTHORIZED') {
      handleForceLogout();
    }
    throw new Error(data.error || '操作失敗');
  }
  if (action !== 'checkUpdates' && action !== 'getBootstrap' && data.data_version) {
    state.dataVersion = String(data.data_version);
  }
  return data;
}

// ============================================================================
// 初始化與事件綁定
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  const apiInput = document.getElementById('api-url-input');
  apiInput.value = state.apiUrl;

  bindAuthEvents();
  bindNavigationAndFilterEvents();
  bindTaskModalEvents();
  bindAdminEvents();

  if (state.timer.running) {
    startTimerTick();
  }

  if (state.token && state.apiUrl) {
    loadBootstrap();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.token && state.currentUser) {
      checkForUpdates();
    }
  });
  window.addEventListener('focus', () => {
    if (state.token && state.currentUser) {
      checkForUpdates();
    }
  });
});

function bindAuthEvents() {
  document.getElementById('toggle-api-config').addEventListener('click', () => {
    document.getElementById('api-config-panel').classList.toggle('hidden');
  });

  document.getElementById('save-api-url-btn').addEventListener('click', () => {
    const val = document.getElementById('api-url-input').value.trim();
    if (!isValidGasUrl(val)) {
      document.getElementById('api-status-text').textContent = '❌ 僅允許 https://script.google.com/macros/s/... 網址';
      showToast('API 網址格式不合法', 'error');
      return;
    }
    state.apiUrl = val;
    localStorage.setItem(STORAGE_KEYS.API_URL, val);
    document.getElementById('api-status-text').textContent = '已儲存網址';
    showToast('已儲存 API 網址', 'success');
  });

  document.getElementById('test-api-url-btn').addEventListener('click', async () => {
    const val = document.getElementById('api-url-input').value.trim();
    const statusEl = document.getElementById('api-status-text');
    if (!isValidGasUrl(val)) {
      statusEl.textContent = '❌ 僅允許 https://script.google.com/macros/s/... 網址';
      showToast('API 網址格式不合法', 'error');
      return;
    }
    state.apiUrl = val;
    localStorage.setItem(STORAGE_KEYS.API_URL, val);
    statusEl.textContent = '連線測試中...';
    try {
      const res = await callApi('ping');
      const verText = res.api_version ? ` (後端 v${res.api_version})` : ' (⚠️ 舊版後端，請於 GAS 建立新版本部署)';
      statusEl.textContent = `✅ ${res.message}${verText}`;
    } catch (err) {
      statusEl.textContent = `❌ ${err.message}`;
    }
  });

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    if (!username || !password.trim()) {
      showToast('請輸入帳號與密碼', 'error');
      return;
    }

    const btn = document.getElementById('login-submit-btn');
    btn.disabled = true;
    btn.textContent = '登入中...';
    try {
      const res = await callApi('login', { username, password });
      if (!res || !res.token) {
        throw new Error('登入憑證無效，請重新登入');
      }
      state.token = res.token;
      sessionStorage.setItem(STORAGE_KEYS.TOKEN, res.token);
      localStorage.removeItem(STORAGE_KEYS.TOKEN);
      await loadBootstrap();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '登入系統';
    }
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    try { await callApi('logout'); } catch (_) {}
    handleForceLogout();
  });

  document.getElementById('open-change-pw-btn').addEventListener('click', () => {
    document.getElementById('user-dropdown').classList.add('hidden');
    document.getElementById('password-modal').classList.remove('hidden');
  });
  document.getElementById('close-pw-modal').addEventListener('click', () => {
    document.getElementById('password-modal').classList.add('hidden');
  });
  document.getElementById('change-pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await callApi('changePassword', {
        old_password: document.getElementById('old-pw-input').value,
        new_password: document.getElementById('new-pw-input').value
      });
      showToast('密碼已更新', 'success');
      document.getElementById('change-pw-form').reset();
      document.getElementById('password-modal').classList.add('hidden');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

function handleForceLogout() {
  stopAutoSync();
  state.token = '';
  state.currentUser = null;
  state.dataVersion = '';
  sessionStorage.removeItem(STORAGE_KEYS.TOKEN);
  localStorage.removeItem(STORAGE_KEYS.TOKEN);
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
}

function applyBootstrapData(data) {
  const prevUnread = state.notifications.filter(n => !n.is_read).length;
  state.currentUser = data.currentUser;
  state.users = data.users || [];
  const predCache = loadJsonStorage(localStorage, STORAGE_KEYS.PREDECESSORS_CACHE, {});
  state.tasks = (data.tasks || []).map(t => ({
    ...t,
    predecessor_id: t.predecessor_id || predCache[t.task_id] || ''
  }));
  state.subtasks = data.subtasks || [];
  state.attachments = data.attachments || [];
  state.comments = data.comments || [];
  state.notifications = data.notifications || [];
  state.timeLogs = data.timeLogs || loadJsonStorage(localStorage, STORAGE_KEYS.TIME_LOGS_CACHE, []);
  if (data.data_version) {
    state.dataVersion = String(data.data_version);
  }
  const nextUnread = state.notifications.filter(n => !n.is_read).length;
  return nextUnread > prevUnread;
}

async function loadBootstrap() {
  if (!state.token) {
    handleForceLogout();
    return;
  }
  try {
    const data = await callApi('getBootstrap');
    if (!data || !data.currentUser || !data.currentUser.user_id) {
      handleForceLogout();
      throw new Error('無法取得有效的使用者資訊，請重新登入');
    }
    applyBootstrapData(data);

    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');
    renderHeaderAndFilters();
    renderActiveView();
    renderNotifications();
    updateTimerDisplays();
    startAutoSync();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function startAutoSync() {
  stopAutoSync();
  state.syncTimerId = setInterval(() => {
    checkForUpdates();
  }, SYNC_INTERVAL_MS);
}

function stopAutoSync() {
  if (state.syncTimerId) {
    clearInterval(state.syncTimerId);
    state.syncTimerId = null;
  }
}

async function checkForUpdates() {
  if (!state.token || !state.currentUser || state.isSyncing) return;
  if (document.visibilityState === 'hidden') return;

  state.isSyncing = true;
  try {
    const res = await callApi('checkUpdates');
    if (res.data_version && String(res.data_version) !== state.dataVersion) {
      await silentSyncBootstrap();
    }
  } catch (err) {
    if (err && String(err.message).includes('未知的操作指令')) {
      stopAutoSync();
      showToast('GAS 後端尚未更新部署版本，自動同步已暫停（請在 Apps Script 建立新版本並部署）', 'error');
    }
  } finally {
    state.isSyncing = false;
  }
}

async function silentSyncBootstrap() {
  const data = await callApi('getBootstrap');
  if (!data || !data.currentUser || !data.currentUser.user_id) return;

  const hasNewNotif = applyBootstrapData(data);
  renderHeaderAndFilters();
  renderActiveView();
  renderNotifications();
  updateTimerDisplays();

  // 若任務詳情抽屜正開啟，僅局部刷新協作區塊（留言/子任務/附件/工時），不覆蓋正在編輯的表單欄位
  const drawerOpen = !document.getElementById('task-modal').classList.contains('hidden');
  if (drawerOpen && state.editingTaskId) {
    renderTaskCollabSections(state.editingTaskId);
  }

  if (hasNewNotif) {
    showToast('收到新的任務或討論更新');
  }
}

// ============================================================================
// 導覽列、篩選與通知渲染
// ============================================================================
function bindNavigationAndFilterEvents() {
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeView = btn.dataset.view;
      document.getElementById('sidebar').classList.remove('open');
      renderActiveView();
    });
  });

  document.getElementById('open-sidebar-btn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('open');
  });
  document.getElementById('close-sidebar-btn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
  });

  document.getElementById('gantt-zoom-select').addEventListener('change', e => {
    state.ganttZoom = e.target.value;
    if (state.activeView === 'gantt') renderActiveView();
  });

  document.getElementById('dash-dept-filter').addEventListener('change', () => {
    if (state.activeView === 'dashboard') renderDashboard();
  });

  document.getElementById('sidebar-timer-stop-btn').addEventListener('click', () => {
    stopAndLogActiveTimer();
  });

  ['filter-search', 'filter-priority', 'filter-assignee', 'filter-only-mine'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => renderActiveView());
  });

  document.getElementById('user-menu-btn').addEventListener('click', () => {
    document.getElementById('user-dropdown').classList.toggle('hidden');
    document.getElementById('notif-dropdown').classList.add('hidden');
  });

  document.getElementById('notif-bell-btn').addEventListener('click', () => {
    document.getElementById('notif-dropdown').classList.toggle('hidden');
    document.getElementById('user-dropdown').classList.add('hidden');
  });

  document.getElementById('mark-all-read-btn').addEventListener('click', async () => {
    try {
      await callApi('markNotificationsRead', {});
      state.notifications.forEach(n => { n.is_read = true; });
      renderNotifications();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('refresh-data-btn').addEventListener('click', () => {
    document.getElementById('user-dropdown').classList.add('hidden');
    loadBootstrap();
  });

  document.getElementById('new-task-btn').addEventListener('click', () => openTaskModal(null));
}

function renderHeaderAndFilters() {
  const u = state.currentUser;
  document.getElementById('user-avatar').textContent = (u.display_name || u.username).slice(0, 1).toUpperCase();
  document.getElementById('user-display-name').textContent = u.display_name;
  document.getElementById('user-role-dept').textContent = `${ROLE_LABELS[u.role] || u.role} · ${u.department}`;

  const adminTab = document.getElementById('nav-admin-tab');
  if (u.role === 'admin') adminTab.classList.remove('hidden');
  else adminTab.classList.add('hidden');

  const dashTab = document.getElementById('nav-dashboard-tab');
  if (u.role === 'admin' || u.role === 'manager') dashTab.classList.remove('hidden');
  else dashTab.classList.add('hidden');

  const depts = [...new Set(state.users.map(x => x.department).filter(Boolean))];
  const dashDeptFilter = document.getElementById('dash-dept-filter');
  const prevDept = dashDeptFilter.value;
  dashDeptFilter.innerHTML = '<option value="">所有部門</option>' +
    depts.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  dashDeptFilter.value = prevDept;

  const assigneeFilter = document.getElementById('filter-assignee');
  const prevVal = assigneeFilter.value;
  assigneeFilter.innerHTML = '<option value="">所有負責人</option>' +
    state.users.filter(x => x.status === 'active')
      .map(x => `<option value="${escapeHtml(x.user_id)}">${escapeHtml(x.display_name)} (${escapeHtml(x.department)})</option>`)
      .join('');
  assigneeFilter.value = prevVal;
}

function renderNotifications() {
  const unreadCount = state.notifications.filter(n => !n.is_read).length;
  const badge = document.getElementById('notif-badge');
  badge.textContent = unreadCount;
  if (unreadCount > 0) badge.classList.remove('hidden');
  else badge.classList.add('hidden');

  const listEl = document.getElementById('notif-list');
  if (state.notifications.length === 0) {
    listEl.innerHTML = '<div class="notif-item">目前沒有通知</div>';
    return;
  }
  listEl.innerHTML = state.notifications.map(n => `
    <div class="notif-item ${n.is_read ? '' : 'unread'}" data-notif-id="${escapeHtml(n.notif_id)}" data-task-id="${escapeHtml(n.task_id)}">
      <div>${escapeHtml(n.message)}</div>
      <small>${escapeHtml(formatDateTime(n.created_at))}</small>
    </div>
  `).join('');

  listEl.querySelectorAll('.notif-item[data-task-id]').forEach(el => {
    el.addEventListener('click', async () => {
      const notifId = el.dataset.notifId;
      const taskId = el.dataset.taskId;
      document.getElementById('notif-dropdown').classList.add('hidden');
      const target = state.notifications.find(n => n.notif_id === notifId);
      if (target && !target.is_read) {
        target.is_read = true;
        renderNotifications();
        callApi('markNotificationsRead', { notif_id: notifId }).catch(() => {});
      }
      if (taskId) openTaskModal(taskId);
    });
  });
}

function getFilteredTasks() {
  const q = document.getElementById('filter-search').value.trim().toLowerCase();
  const priority = document.getElementById('filter-priority').value;
  const assignee = document.getElementById('filter-assignee').value;
  const onlyMine = document.getElementById('filter-only-mine').checked;

  return state.tasks.filter(t => {
    if (priority && t.priority !== priority) return false;
    const assignees = getTaskAssigneeIds(t);
    if (assignee && !assignees.includes(assignee)) return false;
    if (onlyMine && !assignees.includes(state.currentUser.user_id)) return false;
    if (q) {
      const hay = `${t.title} ${t.description} ${(t.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderActiveView() {
  document.getElementById('view-title').textContent = VIEW_TITLES[state.activeView] || 'TaskFlow';
  document.getElementById('view-kanban').classList.toggle('hidden', state.activeView !== 'kanban');
  document.getElementById('view-list').classList.toggle('hidden', state.activeView !== 'list');
  document.getElementById('view-gantt').classList.toggle('hidden', state.activeView !== 'gantt');
  document.getElementById('view-dashboard').classList.toggle('hidden', state.activeView !== 'dashboard');
  document.getElementById('view-admin').classList.toggle('hidden', state.activeView !== 'admin');
  document.getElementById('filter-bar').classList.toggle('hidden', state.activeView === 'admin' || state.activeView === 'dashboard');

  const filtered = getFilteredTasks();
  document.getElementById('filter-summary').textContent = `共 ${filtered.length} 項任務`;

  if (state.activeView === 'kanban') renderKanban(filtered);
  else if (state.activeView === 'list') renderListView(filtered);
  else if (state.activeView === 'gantt') renderGantt(filtered);
  else if (state.activeView === 'dashboard') renderDashboard();
  else if (state.activeView === 'admin') renderAdminUsers();
}

// ============================================================================
// Kanban 看板檢視（支援拖拉切換狀態）
// ============================================================================
function renderKanban(tasks) {
  const board = document.getElementById('kanban-board');
  const today = new Date().toISOString().slice(0, 10);

  board.innerHTML = COLUMNS.map(col => {
    const colTasks = tasks.filter(t => t.status === col.key);
    return `
      <div class="kanban-col" data-status="${col.key}">
        <div class="kanban-col-header">
          <span>${col.label}</span>
          <span class="col-count">${colTasks.length}</span>
        </div>
        <div class="kanban-cards">
          ${colTasks.map(t => renderKanbanCard(t, today)).join('')}
        </div>
      </div>
    `;
  }).join('');

  board.querySelectorAll('.task-card').forEach(card => {
    card.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', card.dataset.taskId);
    });
    card.addEventListener('click', () => openTaskModal(card.dataset.taskId));
  });

  board.querySelectorAll('.card-timer-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const tid = btn.dataset.timerTaskId;
      if (state.timer.taskId === tid && state.timer.running) {
        await stopAndLogActiveTimer();
      } else {
        await startTaskTimer(tid);
      }
    });
  });

  board.querySelectorAll('.kanban-col').forEach(colEl => {
    colEl.addEventListener('dragover', e => {
      e.preventDefault();
      colEl.classList.add('drag-over');
    });
    colEl.addEventListener('dragleave', () => colEl.classList.remove('drag-over'));
    colEl.addEventListener('drop', async e => {
      e.preventDefault();
      colEl.classList.remove('drag-over');
      const taskId = e.dataTransfer.getData('text/plain');
      const newStatus = colEl.dataset.status;
      await moveTaskStatus(taskId, newStatus);
    });
  });
}

function renderKanbanCard(t, today) {
  const assignee = getTaskAssigneeNames(t);
  const subs = state.subtasks.filter(s => s.task_id === t.task_id);
  const subDone = subs.filter(s => s.is_done).length;
  const attCount = state.attachments.filter(a => a.task_id === t.task_id).length;
  const cmtCount = state.comments.filter(c => c.task_id === t.task_id).length;
  const isOverdue = t.due_date && t.due_date < today && t.status !== 'done';
  const priorityClass = VALID_PRIORITIES.has(t.priority) ? t.priority : 'medium';
  const loggedHrs = getTaskLoggedHours(t.task_id);
  const isTimerRunning = state.timer.running && state.timer.taskId === t.task_id;

  return `
    <div class="task-card priority-${priorityClass}" draggable="true" data-task-id="${escapeHtml(t.task_id)}">
      <div class="card-tags">
        ${(t.tags || []).map(tag => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join('')}
        ${t.recurrence && t.recurrence !== 'none' ? `<span class="tag-chip">🔁 週期</span>` : ''}
      </div>
      <div class="card-title">${escapeHtml(t.title)}</div>
      <div class="card-meta">
        <span>👤 ${escapeHtml(assignee)}</span>
        ${t.due_date ? `<span class="${isOverdue ? 'due-overdue' : ''}">📅 ${escapeHtml(t.due_date)}</span>` : ''}
      </div>
      <div class="card-meta" style="margin-top:6px;">
        <span>${subs.length ? `☑️ ${subDone}/${subs.length}` : ''}</span>
        <span>${attCount ? `📎 ${attCount}` : ''} ${cmtCount ? `💬 ${cmtCount}` : ''}</span>
      </div>
      <div class="card-footer-row">
        <span class="card-meta">${loggedHrs > 0 ? `⏱️ ${loggedHrs.toFixed(1)}h` : (t.estimated_hours ? `預估 ${t.estimated_hours}h` : '')}</span>
        <button type="button" class="card-timer-btn ${isTimerRunning ? 'running' : ''}" data-timer-task-id="${escapeHtml(t.task_id)}">
          ${isTimerRunning ? `⏹ ${formatDuration(getCurrentTimerMs())}` : '▶ 計時'}
        </button>
      </div>
    </div>
  `;
}

async function moveTaskStatus(taskId, newStatus) {
  const task = state.tasks.find(t => t.task_id === taskId);
  if (!task || task.status === newStatus) return;

  const oldStatus = task.status;
  task.status = newStatus;
  renderActiveView();

  try {
    const res = await callApi('moveTask', { task_id: taskId, status: newStatus });
    Object.assign(task, res.task);
    if (res.nextRecurringTask) {
      state.tasks.unshift(res.nextRecurringTask);
      showToast('已自動建立下一期週期任務', 'success');
    }
    renderActiveView();
  } catch (err) {
    task.status = oldStatus;
    renderActiveView();
    showToast(err.message, 'error');
  }
}

// ============================================================================
// 清單檢視
// ============================================================================
function renderListView(tasks) {
  const tbody = document.getElementById('list-table-body');
  const today = new Date().toISOString().slice(0, 10);

  tbody.innerHTML = tasks.map(t => {
    const subs = state.subtasks.filter(s => s.task_id === t.task_id);
    const subDone = subs.filter(s => s.is_done).length;
    const isOverdue = t.due_date && t.due_date < today && t.status !== 'done';
    const colLabel = (COLUMNS.find(c => c.key === t.status) || {}).label || t.status;

    return `
      <tr data-task-id="${escapeHtml(t.task_id)}">
        <td><input type="checkbox" class="list-done-cb" data-task-id="${escapeHtml(t.task_id)}" ${t.status === 'done' ? 'checked' : ''} /></td>
        <td><strong>${escapeHtml(t.title)}</strong></td>
        <td>${escapeHtml(colLabel)}</td>
        <td>${escapeHtml(PRIORITY_LABELS[t.priority] || t.priority)}</td>
        <td>${escapeHtml(getTaskAssigneeNames(t))}</td>
        <td>${escapeHtml(t.department || '')}</td>
        <td class="${isOverdue ? 'due-overdue' : ''}">${escapeHtml(t.due_date || '-')}</td>
        <td>${subs.length ? `${subDone}/${subs.length}` : '-'}</td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.classList.contains('list-done-cb')) return;
      openTaskModal(tr.dataset.taskId);
    });
  });

  tbody.querySelectorAll('.list-done-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      moveTaskStatus(cb.dataset.taskId, cb.checked ? 'done' : 'todo');
    });
  });
}

// ============================================================================
// 任務詳情 Modal（含子任務、Drive 附件與 @標記 留言）
// ============================================================================
function bindTaskModalEvents() {
  const drawerOverlay = document.getElementById('task-modal');
  document.getElementById('close-task-modal').addEventListener('click', () => {
    drawerOverlay.classList.add('hidden');
  });
  drawerOverlay.addEventListener('click', e => {
    if (e.target === drawerOverlay) drawerOverlay.classList.add('hidden');
  });

  document.getElementById('task-form').addEventListener('submit', async e => {
    e.preventDefault();
    const saveBtn = document.getElementById('save-task-btn');
    saveBtn.disabled = true;
    try {
      const predecessorId = document.getElementById('task-predecessor-input').value;
      const assigneeIds = Array.from(document.querySelectorAll('input[name="task-assignee-cb"]:checked'))
        .map(cb => cb.value)
        .filter(Boolean);
      const payload = {
        title: document.getElementById('task-title-input').value.trim(),
        description: document.getElementById('task-desc-input').value.trim(),
        status: document.getElementById('task-status-input').value,
        priority: document.getElementById('task-priority-input').value,
        assignee_ids: assigneeIds,
        assignee_id: assigneeIds[0] || '',
        department: document.getElementById('task-dept-input').value.trim(),
        start_date: document.getElementById('task-start-input').value,
        due_date: document.getElementById('task-due-input').value,
        recurrence: document.getElementById('task-recurrence-input').value,
        tags: document.getElementById('task-tags-input').value.split(',').map(s => s.trim()).filter(Boolean),
        estimated_hours: Number(document.getElementById('task-est-hours-input').value || 0),
        predecessor_id: predecessorId
      };

      if (state.editingTaskId) {
        payload.task_id = state.editingTaskId;
        const res = await callApi('updateTask', payload);
        const idx = state.tasks.findIndex(t => t.task_id === state.editingTaskId);
        if (idx !== -1) state.tasks[idx] = { ...res.task, predecessor_id: res.task.predecessor_id ?? predecessorId };
        savePredecessorCache(state.editingTaskId, predecessorId);
        if (res.nextRecurringTask) state.tasks.unshift(res.nextRecurringTask);
        showToast('任務已更新', 'success');
      } else {
        const res = await callApi('createTask', payload);
        const created = { ...res.task, predecessor_id: res.task.predecessor_id ?? predecessorId };
        savePredecessorCache(created.task_id, predecessorId);
        state.tasks.unshift(created);
        state.editingTaskId = created.task_id;
        showToast('任務已建立', 'success');
      }
      renderActiveView();
      openTaskModal(state.editingTaskId);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });

  document.getElementById('archive-task-btn').addEventListener('click', async () => {
    if (!state.editingTaskId || !confirm('確定要封存此任務嗎？')) return;
    try {
      await callApi('archiveTask', { task_id: state.editingTaskId });
      state.tasks = state.tasks.filter(t => t.task_id !== state.editingTaskId);
      document.getElementById('task-modal').classList.add('hidden');
      renderActiveView();
      showToast('已封存任務', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // 子任務與核對清單
  document.getElementById('add-subtask-btn').addEventListener('click', async () => {
    const title = document.getElementById('new-subtask-input').value.trim();
    const itemType = document.getElementById('subtask-type-select').value;
    if (!title || !state.editingTaskId) return;
    try {
      const res = await callApi('saveSubtask', { task_id: state.editingTaskId, title, item_type: itemType });
      state.subtasks.push(res.subtask);
      document.getElementById('new-subtask-input').value = '';
      renderTaskCollabSections(state.editingTaskId);
      renderActiveView();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // 外部連結附件
  document.getElementById('add-att-link-btn').addEventListener('click', async () => {
    const name = document.getElementById('att-link-name').value.trim();
    const url = document.getElementById('att-link-url').value.trim();
    if (!name || !url || !state.editingTaskId) return;
    if (!sanitizeUrl(url)) {
      showToast('僅允許 http:// 或 https:// 開頭的外部連結', 'error');
      return;
    }
    try {
      const res = await callApi('addAttachmentLink', { task_id: state.editingTaskId, name, url });
      state.attachments.push(res.attachment);
      document.getElementById('att-link-name').value = '';
      document.getElementById('att-link-url').value = '';
      renderTaskCollabSections(state.editingTaskId);
      renderActiveView();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // 上傳檔案至 Google Drive
  document.getElementById('upload-file-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file || !state.editingTaskId) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!ALLOWED_FILE_EXTENSIONS.has(ext)) {
      showToast('不支援的檔案格式，僅允許常見文件、圖片或壓縮檔', 'error');
      e.target.value = '';
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      showToast('單一檔案上限為 10 MB，較大檔案建議改貼雲端連結', 'error');
      e.target.value = '';
      return;
    }
    showToast('正在上傳檔案至 Google Drive...');
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const base64Data = String(reader.result).split(',')[1];
        const res = await callApi('uploadAttachmentFile', {
          task_id: state.editingTaskId,
          file_name: file.name,
          mime_type: file.type || 'application/octet-stream',
          base64_data: base64Data
        });
        state.attachments.push(res.attachment);
        renderTaskCollabSections(state.editingTaskId);
        renderActiveView();
        showToast('檔案已上傳至 Google Drive', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        e.target.value = '';
      }
    };
    reader.readAsDataURL(file);
  });

  // 留言與 @標記
  document.getElementById('add-comment-btn').addEventListener('click', async () => {
    const input = document.getElementById('new-comment-input');
    const content = input.value.trim();
    if (!content || !state.editingTaskId) return;
    try {
      const res = await callApi('addComment', { task_id: state.editingTaskId, content });
      state.comments.push(res.comment);
      input.value = '';
      renderTaskCollabSections(state.editingTaskId);
      renderActiveView();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // 抽屜計時器與手動補登工時
  document.getElementById('drawer-timer-start-btn').addEventListener('click', () => {
    if (state.editingTaskId) startTaskTimer(state.editingTaskId);
  });
  document.getElementById('drawer-timer-pause-btn').addEventListener('click', () => {
    pauseActiveTimer();
  });
  document.getElementById('drawer-timer-stop-btn').addEventListener('click', () => {
    stopAndLogActiveTimer();
  });
  document.getElementById('add-manual-time-btn').addEventListener('click', async () => {
    if (!state.editingTaskId) return;
    const workDate = document.getElementById('manual-time-date').value || new Date().toISOString().slice(0, 10);
    const hours = Number(document.getElementById('manual-time-hours').value);
    const note = document.getElementById('manual-time-note').value.trim();
    if (!hours || hours <= 0 || hours > 24) {
      showToast('請輸入 0.1 至 24 之間的有效工時', 'error');
      return;
    }
    await logTimeEntry(state.editingTaskId, hours, workDate, note || '手動補登工時');
    document.getElementById('manual-time-hours').value = '';
    document.getElementById('manual-time-note').value = '';
  });
}

function openTaskModal(taskId) {
  state.editingTaskId = taskId;
  const task = taskId ? state.tasks.find(t => t.task_id === taskId) : null;
  const selectedAssignees = new Set(task ? getTaskAssigneeIds(task) : [state.currentUser.user_id]);
  const assigneeListEl = document.getElementById('task-assignee-list');
  assigneeListEl.innerHTML = state.users.filter(u => u.status === 'active')
    .map(u => `
      <label class="assignee-option">
        <input type="checkbox" name="task-assignee-cb" value="${escapeHtml(u.user_id)}" ${selectedAssignees.has(u.user_id) ? 'checked' : ''} />
        <span>${escapeHtml(u.display_name)} (${escapeHtml(u.department)})</span>
      </label>
    `).join('');

  document.getElementById('task-modal-title').textContent = task ? '編輯任務' : '新增任務';
  document.getElementById('task-id-input').value = task ? task.task_id : '';
  document.getElementById('task-title-input').value = task ? task.title : '';
  document.getElementById('task-desc-input').value = task ? task.description : '';
  document.getElementById('task-status-input').value = task ? task.status : 'todo';
  document.getElementById('task-priority-input').value = task ? task.priority : 'medium';
  document.getElementById('task-dept-input').value = task ? task.department : state.currentUser.department;
  document.getElementById('task-start-input').value = task ? (task.start_date || '') : '';
  document.getElementById('task-due-input').value = task ? (task.due_date || '') : '';
  document.getElementById('task-recurrence-input').value = task ? (task.recurrence || 'none') : 'none';
  document.getElementById('task-tags-input').value = task ? (task.tags || []).join(', ') : '';
  document.getElementById('task-est-hours-input').value = task ? (task.estimated_hours || 0) : 0;

  const predSelect = document.getElementById('task-predecessor-input');
  predSelect.innerHTML = '<option value="">無前置任務</option>' +
    state.tasks
      .filter(t => t.task_id !== taskId)
      .map(t => `<option value="${escapeHtml(t.task_id)}">${escapeHtml(t.title)}</option>`)
      .join('');
  predSelect.value = task ? (task.predecessor_id || '') : '';
  document.getElementById('manual-time-date').value = new Date().toISOString().slice(0, 10);

  document.getElementById('archive-task-btn').classList.toggle('hidden', !task);
  document.getElementById('task-collab-sections').classList.toggle('hidden', !task);

  if (task) renderTaskCollabSections(task.task_id);
  updateTimerDisplays();
  document.getElementById('task-modal').classList.remove('hidden');
}

function renderTaskCollabSections(taskId) {
  // 工時紀錄
  const taskObj = state.tasks.find(t => t.task_id === taskId);
  const logs = state.timeLogs.filter(l => l.task_id === taskId);
  const totalLogged = logs.reduce((sum, l) => sum + Number(l.hours || 0), 0);
  const estHours = Number((taskObj && taskObj.estimated_hours) || 0);
  document.getElementById('drawer-hours-summary').textContent =
    `已登錄 ${totalLogged.toFixed(1)} 小時 / 預估 ${estHours} 小時`;

  const timeListEl = document.getElementById('timelog-list');
  if (logs.length === 0) {
    timeListEl.innerHTML = '<li class="subtask-item"><span>尚無工時紀錄</span></li>';
  } else {
    timeListEl.innerHTML = logs.map(l => `
      <li class="subtask-item">
        <span>
          <strong>${escapeHtml(getUserName(l.user_id))}</strong>
          · ${escapeHtml(l.work_date || '')}
          · <strong>${Number(l.hours || 0).toFixed(2)}h</strong>
          ${l.note ? `（${escapeHtml(l.note)}）` : ''}
        </span>
        <button type="button" class="btn-link danger-text timelog-del-btn" data-log-id="${escapeHtml(l.log_id)}">刪除</button>
      </li>
    `).join('');
    timeListEl.querySelectorAll('.timelog-del-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteTimeLog(btn.dataset.logId, taskId));
    });
  }

  // 子任務
  const subs = state.subtasks.filter(s => s.task_id === taskId);
  const subEl = document.getElementById('subtask-list');
  subEl.innerHTML = subs.map(s => `
    <li class="subtask-item">
      <label>
        <input type="checkbox" class="sub-toggle-cb" data-sub-id="${escapeHtml(s.subtask_id)}" ${s.is_done ? 'checked' : ''} />
        <span class="${s.is_done ? 'subtask-done' : ''}">[${s.item_type === 'checklist' ? '核對' : '子任務'}] ${escapeHtml(s.title)}</span>
      </label>
      <button type="button" class="btn-link danger-text sub-del-btn" data-sub-id="${escapeHtml(s.subtask_id)}">刪除</button>
    </li>
  `).join('');

  subEl.querySelectorAll('.sub-toggle-cb').forEach(cb => {
    cb.addEventListener('change', async () => {
      const item = state.subtasks.find(x => x.subtask_id === cb.dataset.subId);
      if (item) item.is_done = cb.checked;
      renderTaskCollabSections(taskId);
      renderActiveView();
      await callApi('toggleSubtask', { subtask_id: cb.dataset.subId, is_done: cb.checked }).catch(() => {});
    });
  });

  subEl.querySelectorAll('.sub-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await callApi('deleteSubtask', { subtask_id: btn.dataset.subId });
      state.subtasks = state.subtasks.filter(x => x.subtask_id !== btn.dataset.subId);
      renderTaskCollabSections(taskId);
      renderActiveView();
    });
  });

  // 附件
  const atts = state.attachments.filter(a => a.task_id === taskId);
  const attEl = document.getElementById('attachment-list');
  attEl.innerHTML = atts.map(a => {
    const safeUrl = sanitizeUrl(a.url);
    const label = `${a.source_type === 'drive' ? '📁 [Drive]' : '🔗 [連結]'} ${escapeHtml(a.name)}`;
    const linkHtml = safeUrl
      ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : `<span>${label} (無效連結)</span>`;
    return `
      <li class="attachment-item">
        ${linkHtml}
        <button type="button" class="btn-link danger-text att-del-btn" data-att-id="${escapeHtml(a.attachment_id)}">移除</button>
      </li>
    `;
  }).join('');

  attEl.querySelectorAll('.att-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await callApi('deleteAttachment', { attachment_id: btn.dataset.attId });
      state.attachments = state.attachments.filter(x => x.attachment_id !== btn.dataset.attId);
      renderTaskCollabSections(taskId);
      renderActiveView();
    });
  });

  // @標記快速按鈕與留言
  const chipsEl = document.getElementById('mention-chips');
  chipsEl.innerHTML = state.users.filter(u => u.status === 'active').map(u => `
    <button type="button" class="mention-chip" data-mention="@${escapeHtml(u.display_name)}">@${escapeHtml(u.display_name)}</button>
  `).join('');
  chipsEl.querySelectorAll('.mention-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById('new-comment-input');
      input.value = `${input.value} ${btn.dataset.mention} `.trimStart();
      input.focus();
    });
  });

  const cmts = state.comments.filter(c => c.task_id === taskId);
  document.getElementById('comment-list').innerHTML = cmts.map(c => `
    <div class="comment-item">
      <div class="comment-meta">
        <strong>${escapeHtml(getUserName(c.author_id))}</strong>
        <span>${escapeHtml(formatDateTime(c.created_at))}</span>
      </div>
      <div>${escapeHtml(c.content)}</div>
    </div>
  `).join('');
}

// ============================================================================
// 管理員帳號管理
// ============================================================================
function bindAdminEvents() {
  document.getElementById('admin-create-user-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const res = await callApi('adminCreateUser', {
        username: document.getElementById('new-user-username').value.trim(),
        password: document.getElementById('new-user-password').value,
        display_name: document.getElementById('new-user-display').value.trim(),
        email: document.getElementById('new-user-email').value.trim(),
        role: document.getElementById('new-user-role').value,
        department: document.getElementById('new-user-dept').value.trim()
      });
      state.users.push(res.user);
      e.target.reset();
      renderAdminUsers();
      renderHeaderAndFilters();
      showToast('已建立新帳號', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
  document.getElementById('close-reset-pw-modal').addEventListener('click', () => {
    document.getElementById('reset-pw-modal').classList.add('hidden');
  });

  document.getElementById('admin-reset-pw-form').addEventListener('submit', async e => {
    e.preventDefault();
    const uid = document.getElementById('reset-pw-uid').value;
    const pw = document.getElementById('admin-reset-pw-input').value;
    if (!uid || pw.length < 6) {
      showToast('新密碼至少需 6 碼', 'error');
      return;
    }
    try {
      await callApi('adminResetPassword', { user_id: uid, new_password: pw });
      e.target.reset();
      document.getElementById('reset-pw-modal').classList.add('hidden');
      showToast('已重設密碼', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

function renderAdminUsers() {
  const tbody = document.getElementById('admin-users-tbody');
  tbody.innerHTML = state.users.map(u => `
    <tr>
      <td>${escapeHtml(u.username)}</td>
      <td>${escapeHtml(u.display_name)}</td>
      <td>${escapeHtml(ROLE_LABELS[u.role] || u.role)}</td>
      <td>${escapeHtml(u.department)}</td>
      <td>${escapeHtml(u.email || '-')}</td>
      <td>${u.status === 'active' ? '✅ 啟用' : '⛔ 停用'}</td>
      <td>
        <button type="button" class="btn-link toggle-user-btn" data-uid="${escapeHtml(u.user_id)}" data-status="${escapeHtml(u.status)}">
          ${u.status === 'active' ? '停用' : '啟用'}
        </button>
        ·
        <button type="button" class="btn-link reset-pw-btn" data-uid="${escapeHtml(u.user_id)}">重設密碼</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.toggle-user-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const nextStatus = btn.dataset.status === 'active' ? 'disabled' : 'active';
      const res = await callApi('adminUpdateUser', { user_id: btn.dataset.uid, status: nextStatus });
      const idx = state.users.findIndex(x => x.user_id === btn.dataset.uid);
      if (idx !== -1) state.users[idx] = res.user;
      renderAdminUsers();
    });
  });

  tbody.querySelectorAll('.reset-pw-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('reset-pw-uid').value = btn.dataset.uid;
      document.getElementById('admin-reset-pw-input').value = '';
      document.getElementById('reset-pw-modal').classList.remove('hidden');
    });
  });
}

// ============================================================================
// 小工具
// ============================================================================
function getUserName(uid) {
  const u = state.users.find(x => x.user_id === uid);
  return u ? u.display_name : '未指派';
}

function getTaskAssigneeIds(task) {
  if (!task) return [];
  if (Array.isArray(task.assignee_ids)) {
    return task.assignee_ids.filter(Boolean);
  }
  const raw = task.assignee_id;
  if (Array.isArray(raw)) return raw.filter(Boolean);
  const str = String(raw || '').trim();
  if (!str) return [];
  if (str.startsWith('[')) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) return parsed.map(x => String(x || '').trim()).filter(Boolean);
    } catch (_) {}
  }
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

function getTaskAssigneeNames(task) {
  const ids = getTaskAssigneeIds(task);
  if (!ids.length) return '未指派';
  return ids.map(id => getUserName(id)).join(', ');
}

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString('zh-TW', { hour12: false });
}

function isValidGasUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    return parsed.protocol === 'https:' &&
      parsed.hostname === 'script.google.com' &&
      parsed.pathname.includes('/macros/s/');
  } catch (_) {
    return false;
  }
}

function sanitizeUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
    return '';
  } catch (_) {
    return '';
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(msg, type = '') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ============================================================================
// 甘特圖 / 時間軸檢視（含前置任務相依線）
// ============================================================================
function renderGantt(tasks) {
  const container = document.getElementById('gantt-container');
  if (!tasks.length) {
    container.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);">目前篩選條件下沒有任務</div>';
    return;
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const dayMs = 24 * 60 * 60 * 1000;
  const parsedTasks = tasks.map(t => {
    const startStr = t.start_date || t.due_date || todayStr;
    const endStr = t.due_date || t.start_date || todayStr;
    let sDate = new Date(`${startStr}T00:00:00`);
    let eDate = new Date(`${endStr}T00:00:00`);
    if (isNaN(sDate.getTime())) sDate = new Date(`${todayStr}T00:00:00`);
    if (isNaN(eDate.getTime()) || eDate < sDate) eDate = new Date(sDate.getTime());
    return { task: t, sDate, eDate };
  });

  let minTime = Math.min(...parsedTasks.map(x => x.sDate.getTime()));
  let maxTime = Math.max(...parsedTasks.map(x => x.eDate.getTime()));
  minTime -= 2 * dayMs;
  maxTime += 4 * dayMs;
  const totalDays = Math.max(14, Math.round((maxTime - minTime) / dayMs) + 1);
  const stepDays = state.ganttZoom === 'week' ? 7 : 1;

  const ticks = [];
  for (let i = 0; i < totalDays; i += stepDays) {
    const d = new Date(minTime + i * dayMs);
    const iso = d.toISOString().slice(0, 10);
    ticks.push({
      iso,
      label: state.ganttZoom === 'week' ? `${d.getMonth() + 1}/${d.getDate()}週` : `${d.getMonth() + 1}/${d.getDate()}`,
      isToday: iso === todayStr
    });
  }

  const rowHtml = parsedTasks.map(({ task: t, sDate, eDate }) => {
    const startOffsetDays = (sDate.getTime() - minTime) / dayMs;
    const durationDays = Math.max(1, Math.round((eDate.getTime() - sDate.getTime()) / dayMs) + 1);
    const leftPct = (startOffsetDays / totalDays) * 100;
    const widthPct = Math.max(2.5, (durationDays / totalDays) * 100);
    const isOverdue = t.due_date && t.due_date < todayStr && t.status !== 'done';
    const statusClass = isOverdue ? 'overdue' : (['todo', 'in_progress', 'review', 'done'].includes(t.status) ? t.status : 'todo');

    return `
      <div class="gantt-row" data-gantt-task-id="${escapeHtml(t.task_id)}">
        <div class="gantt-label-col">
          <div class="gantt-label-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</div>
          <div class="gantt-label-meta">${escapeHtml(getTaskAssigneeNames(t))} · ${escapeHtml(t.start_date || '-')} ~ ${escapeHtml(t.due_date || '-')}</div>
        </div>
        <div class="gantt-timeline-col">
          <div class="gantt-tick-cells">
            ${ticks.map(tk => `<div class="gantt-tick-cell ${tk.isToday ? 'is-today' : ''}"></div>`).join('')}
          </div>
          <div class="gantt-bar status-${statusClass}" data-bar-task-id="${escapeHtml(t.task_id)}" style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;">
            ${escapeHtml(t.title)}
          </div>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <div class="gantt-table" id="gantt-table">
      <div class="gantt-header-row">
        <div class="gantt-label-col">任務名稱 / 負責人</div>
        <div class="gantt-timeline-col">
          <div class="gantt-tick-cells">
            ${ticks.map(tk => `<div class="gantt-tick-cell ${tk.isToday ? 'is-today' : ''}">${escapeHtml(tk.label)}</div>`).join('')}
          </div>
        </div>
      </div>
      ${rowHtml}
      <svg class="gantt-svg-layer" id="gantt-svg-layer"></svg>
    </div>
  `;

  container.querySelectorAll('.gantt-bar').forEach(bar => {
    bar.addEventListener('click', () => openTaskModal(bar.dataset.barTaskId));
  });

  drawGanttDependencies(parsedTasks);
}

function drawGanttDependencies(parsedTasks) {
  const tableEl = document.getElementById('gantt-table');
  const svgEl = document.getElementById('gantt-svg-layer');
  if (!tableEl || !svgEl) return;

  const rect = tableEl.getBoundingClientRect();
  svgEl.setAttribute('width', String(tableEl.scrollWidth));
  svgEl.setAttribute('height', String(tableEl.scrollHeight));

  const paths = [];
  parsedTasks.forEach(({ task: t }) => {
    if (!t.predecessor_id) return;
    const fromBar = tableEl.querySelector(`.gantt-bar[data-bar-task-id="${CSS.escape(t.predecessor_id)}"]`);
    const toBar = tableEl.querySelector(`.gantt-bar[data-bar-task-id="${CSS.escape(t.task_id)}"]`);
    if (!fromBar || !toBar) return;

    const r1 = fromBar.getBoundingClientRect();
    const r2 = toBar.getBoundingClientRect();
    const x1 = r1.right - rect.left;
    const y1 = r1.top + r1.height / 2 - rect.top;
    const x2 = r2.left - rect.left;
    const y2 = r2.top + r2.height / 2 - rect.top;
    const midX = x1 + (x2 - x1) / 2;
    paths.push(`<path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" fill="none" stroke="#6366f1" stroke-width="2" marker-end="url(#gantt-arrow)" />`);
  });

  svgEl.innerHTML = `
    <defs>
      <marker id="gantt-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L0,6 L6,3 z" fill="#6366f1" />
      </marker>
    </defs>
    ${paths.join('')}
  `;
}

// ============================================================================
// 主管數據儀表板
// ============================================================================
function renderDashboard() {
  const deptFilter = document.getElementById('dash-dept-filter').value;
  const todayStr = new Date().toISOString().slice(0, 10);

  const tasks = state.tasks.filter(t => !deptFilter || t.department === deptFilter);
  const taskIds = new Set(tasks.map(t => t.task_id));
  const logs = state.timeLogs.filter(l => taskIds.has(l.task_id));

  const totalTasks = tasks.length;
  const doneTasks = tasks.filter(t => t.status === 'done');
  const overdueActive = tasks.filter(t => t.status !== 'done' && t.due_date && t.due_date < todayStr);
  const onTimeDone = doneTasks.filter(t => !t.due_date || !t.updated_at || t.updated_at.slice(0, 10) <= t.due_date);
  const onTimeRate = doneTasks.length ? Math.round((onTimeDone.length / doneTasks.length) * 100) : 100;
  const totalLoggedHours = logs.reduce((s, l) => s + Number(l.hours || 0), 0);
  const totalEstHours = tasks.reduce((s, t) => s + Number(t.estimated_hours || 0), 0);

  document.getElementById('dashboard-kpis').innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">總任務數</div>
      <div class="kpi-value">${totalTasks}</div>
      <div class="kpi-sub">已完成 ${doneTasks.length} 項</div>
    </div>
    <div class="kpi-card kpi-success">
      <div class="kpi-label">任務準時完成率</div>
      <div class="kpi-value">${onTimeRate}%</div>
      <div class="kpi-sub">準時 ${onTimeDone.length} / 已完成 ${doneTasks.length}</div>
    </div>
    <div class="kpi-card kpi-danger">
      <div class="kpi-label">目前逾期任務</div>
      <div class="kpi-value">${overdueActive.length}</div>
      <div class="kpi-sub">佔未完成 ${tasks.length - doneTasks.length ? Math.round((overdueActive.length / (tasks.length - doneTasks.length)) * 100) : 0}%</div>
    </div>
    <div class="kpi-card kpi-warning">
      <div class="kpi-label">累計登錄工時</div>
      <div class="kpi-value">${totalLoggedHours.toFixed(1)}h</div>
      <div class="kpi-sub">預估總工時 ${totalEstHours.toFixed(1)}h</div>
    </div>
  `;

  // 1. 各成員工時分佈
  const memberHoursMap = new Map();
  state.users.filter(u => !deptFilter || u.department === deptFilter).forEach(u => {
    memberHoursMap.set(u.user_id, { name: u.display_name, logged: 0, est: 0 });
  });
  tasks.forEach(t => {
    const assignees = getTaskAssigneeIds(t);
    if (!assignees.length) return;
    const shareEst = Number(t.estimated_hours || 0) / assignees.length;
    assignees.forEach(uid => {
      if (!memberHoursMap.has(uid)) {
        memberHoursMap.set(uid, { name: getUserName(uid), logged: 0, est: 0 });
      }
      memberHoursMap.get(uid).est += shareEst;
    });
  });
  logs.forEach(l => {
    if (!memberHoursMap.has(l.user_id)) {
      memberHoursMap.set(l.user_id, { name: getUserName(l.user_id), logged: 0, est: 0 });
    }
    memberHoursMap.get(l.user_id).logged += Number(l.hours || 0);
  });
  const memberList = [...memberHoursMap.values()];
  const maxMemberHr = Math.max(1, ...memberList.map(m => Math.max(m.logged, m.est)));
  document.getElementById('chart-member-hours').innerHTML = memberList.length
    ? memberList.map(m => `
        <div class="bar-row">
          <div class="bar-row-head">
            <span>${escapeHtml(m.name)}</span>
            <span>實記 ${m.logged.toFixed(1)}h / 預估 ${m.est.toFixed(1)}h</span>
          </div>
          <div class="bar-track">
            <div class="bar-fill-primary" style="width:${(m.logged / maxMemberHr) * 100}%"></div>
          </div>
        </div>
      `).join('')
    : '<span style="color:var(--text-muted);font-size:13px;">尚無成員工時資料</span>';

  // 2. 準時完成率與狀態分佈 (SVG Donut)
  const statusCounts = [
    { label: '已完成 (準時)', count: onTimeDone.length, color: '#16a34a' },
    { label: '已完成 (逾期)', count: doneTasks.length - onTimeDone.length, color: '#f59e0b' },
    { label: '進行中 / 待辦 (正常)', count: Math.max(0, tasks.length - doneTasks.length - overdueActive.length), color: '#2563eb' },
    { label: '進行中 / 待辦 (逾期)', count: overdueActive.length, color: '#dc2626' }
  ];
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const segments = totalTasks ? statusCounts.map(seg => {
    const len = (seg.count / totalTasks) * circumference;
    const html = `<circle cx="60" cy="60" r="${radius}" fill="transparent" stroke="${seg.color}" stroke-width="18" stroke-dasharray="${len} ${circumference}" stroke-dashoffset="${-offset}" transform="rotate(-90 60 60)" />`;
    offset += len;
    return html;
  }).join('') : `<circle cx="60" cy="60" r="${radius}" fill="transparent" stroke="#e2e8f0" stroke-width="18" />`;

  document.getElementById('chart-ontime-rate').innerHTML = `
    <div class="donut-wrap">
      <svg width="120" height="120" viewBox="0 0 120 120">
        ${segments}
        <text x="60" y="64" text-anchor="middle" font-size="16" font-weight="700" fill="#0f172a">${onTimeRate}%</text>
      </svg>
      <div class="donut-legend">
        ${statusCounts.map(s => `
          <div class="donut-legend-item">
            <span class="donut-swatch" style="background:${s.color}"></span>
            <span>${escapeHtml(s.label)}：<strong>${s.count}</strong></span>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  // 3. 逾期任務統計
  const overdueByPrio = ['urgent', 'high', 'medium', 'low'].map(p => ({
    key: p,
    label: PRIORITY_LABELS[p],
    count: overdueActive.filter(t => t.priority === p).length
  }));
  const maxOverdue = Math.max(1, ...overdueByPrio.map(x => x.count));
  document.getElementById('chart-overdue-stats').innerHTML = `
    ${overdueByPrio.map(x => `
      <div class="bar-row">
        <div class="bar-row-head">
          <span>${escapeHtml(x.label)}</span>
          <span>${x.count} 項</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill-danger" style="width:${(x.count / maxOverdue) * 100}%"></div>
        </div>
      </div>
    `).join('')}
    ${overdueActive.slice(0, 3).map(t => `
      <div style="font-size:12px;color:var(--danger);margin-top:4px;">
        ⚠️ ${escapeHtml(t.title)}（${escapeHtml(getTaskAssigneeNames(t))} · 截止 ${escapeHtml(t.due_date)}）
      </div>
    `).join('')}
  `;

  // 4. 部門工作量分析
  const deptMap = new Map();
  tasks.forEach(t => {
    const dept = t.department || '未分類';
    if (!deptMap.has(dept)) deptMap.set(dept, { dept, count: 0, est: 0, logged: 0 });
    const entry = deptMap.get(dept);
    entry.count += 1;
    entry.est += Number(t.estimated_hours || 0);
    entry.logged += getTaskLoggedHours(t.task_id);
  });
  const deptList = [...deptMap.values()];
  const maxDeptCount = Math.max(1, ...deptList.map(d => d.count));
  document.getElementById('chart-dept-workload').innerHTML = deptList.length
    ? deptList.map(d => `
        <div class="bar-row">
          <div class="bar-row-head">
            <span>${escapeHtml(d.dept)}</span>
            <span>${d.count} 項任務 · 實記 ${d.logged.toFixed(1)}h / 預估 ${d.est.toFixed(1)}h</span>
          </div>
          <div class="bar-track">
            <div class="bar-fill-primary" style="width:${(d.count / maxDeptCount) * 100}%"></div>
          </div>
        </div>
      `).join('')
    : '<span style="color:var(--text-muted);font-size:13px;">尚無部門任務資料</span>';
}

// ============================================================================
// 計時器與工時紀錄輔助函式
// ============================================================================
function loadJsonStorage(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

function savePredecessorCache(taskId, predecessorId) {
  if (!taskId) return;
  const cache = loadJsonStorage(localStorage, STORAGE_KEYS.PREDECESSORS_CACHE, {});
  if (predecessorId) cache[taskId] = predecessorId;
  else delete cache[taskId];
  localStorage.setItem(STORAGE_KEYS.PREDECESSORS_CACHE, JSON.stringify(cache));
}

function loadSavedTimer() {
  return loadJsonStorage(sessionStorage, STORAGE_KEYS.ACTIVE_TIMER, {
    taskId: null,
    startedAt: 0,
    elapsedMs: 0,
    running: false
  });
}

function saveTimerState() {
  sessionStorage.setItem(STORAGE_KEYS.ACTIVE_TIMER, JSON.stringify(state.timer));
}

function getCurrentTimerMs() {
  if (!state.timer.running) return state.timer.elapsedMs || 0;
  return (state.timer.elapsedMs || 0) + Math.max(0, Date.now() - state.timer.startedAt);
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function getTaskLoggedHours(taskId) {
  return state.timeLogs
    .filter(l => l.task_id === taskId)
    .reduce((sum, l) => sum + Number(l.hours || 0), 0);
}

function startTimerTick() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = setInterval(updateTimerDisplays, 1000);
}

async function startTaskTimer(taskId) {
  if (state.timer.running && state.timer.taskId && state.timer.taskId !== taskId) {
    await stopAndLogActiveTimer();
  }
  state.timer = {
    taskId,
    startedAt: Date.now(),
    elapsedMs: state.timer.taskId === taskId ? (state.timer.elapsedMs || 0) : 0,
    running: true
  };
  saveTimerState();
  startTimerTick();
  updateTimerDisplays();
  if (state.activeView === 'kanban') renderActiveView();
}

function pauseActiveTimer() {
  if (!state.timer.running) return;
  state.timer.elapsedMs = getCurrentTimerMs();
  state.timer.startedAt = 0;
  state.timer.running = false;
  saveTimerState();
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  updateTimerDisplays();
}

async function stopAndLogActiveTimer() {
  const taskId = state.timer.taskId;
  const totalMs = getCurrentTimerMs();
  state.timer = { taskId: null, startedAt: 0, elapsedMs: 0, running: false };
  saveTimerState();
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  updateTimerDisplays();
  if (state.activeView === 'kanban') renderActiveView();

  if (!taskId) return;
  const hours = Math.max(0.05, Math.round((totalMs / 3600000) * 100) / 100);
  const todayStr = new Date().toISOString().slice(0, 10);
  await logTimeEntry(taskId, hours, todayStr, '計時器記錄');
}

function updateTimerDisplays() {
  const widget = document.getElementById('sidebar-timer-widget');
  const hasActive = Boolean(state.timer.taskId && (state.timer.running || state.timer.elapsedMs > 0));
  if (widget) {
    widget.classList.toggle('hidden', !hasActive);
    if (hasActive) {
      const t = state.tasks.find(x => x.task_id === state.timer.taskId);
      document.getElementById('sidebar-timer-task').textContent = t ? t.title : '進行中任務';
      document.getElementById('sidebar-timer-clock').textContent = formatDuration(getCurrentTimerMs());
    }
  }

  const drawerClock = document.getElementById('drawer-timer-clock');
  if (drawerClock && state.editingTaskId) {
    const isThisTask = state.timer.taskId === state.editingTaskId;
    drawerClock.textContent = isThisTask ? formatDuration(getCurrentTimerMs()) : '00:00:00';
    document.getElementById('drawer-timer-dot').classList.toggle('active', isThisTask && state.timer.running);
    document.getElementById('drawer-timer-start-btn').classList.toggle('hidden', isThisTask && state.timer.running);
    document.getElementById('drawer-timer-pause-btn').classList.toggle('hidden', !(isThisTask && state.timer.running));
    document.getElementById('drawer-timer-stop-btn').classList.toggle('hidden', !(isThisTask && (state.timer.running || state.timer.elapsedMs > 0)));
  }

  if (state.timer.running && state.timer.taskId) {
    const cardBtn = document.querySelector(`.card-timer-btn[data-timer-task-id="${CSS.escape(state.timer.taskId)}"]`);
    if (cardBtn) cardBtn.textContent = `⏹ ${formatDuration(getCurrentTimerMs())}`;
  }
}

async function logTimeEntry(taskId, hours, workDate, note) {
  const fallbackEntry = {
    log_id: `local_${Date.now()}`,
    task_id: taskId,
    user_id: state.currentUser ? state.currentUser.user_id : '',
    hours: Number(hours),
    work_date: workDate,
    note: note || '',
    created_at: new Date().toISOString()
  };

  try {
    const res = await callApi('logTime', { task_id: taskId, hours: Number(hours), work_date: workDate, note });
    state.timeLogs.unshift(res.timeLog || fallbackEntry);
    showToast(`已記錄 ${Number(hours).toFixed(2)} 小時工時`, 'success');
  } catch (_) {
    state.timeLogs.unshift(fallbackEntry);
    localStorage.setItem(STORAGE_KEYS.TIME_LOGS_CACHE, JSON.stringify(state.timeLogs));
    showToast(`已於本機記錄 ${Number(hours).toFixed(2)} 小時工時`, 'success');
  }

  if (state.editingTaskId === taskId) renderTaskCollabSections(taskId);
  renderActiveView();
}

async function deleteTimeLog(logId, taskId) {
  try {
    if (!String(logId).startsWith('local_')) {
      await callApi('deleteTimeLog', { log_id: logId });
    }
  } catch (_) {}
  state.timeLogs = state.timeLogs.filter(l => l.log_id !== logId);
  localStorage.setItem(STORAGE_KEYS.TIME_LOGS_CACHE, JSON.stringify(state.timeLogs));
  if (state.editingTaskId === taskId) renderTaskCollabSections(taskId);
  renderActiveView();
  showToast('已刪除工時紀錄', 'success');
}