/**
 * TaskFlow 前端核心邏輯 (第一階段：登入、三級權限、Kanban 看板、清單、任務協作)
 */

// 可直接在此填入部署後的 Google Apps Script Web App 網址，或在登入畫面的「設定」中輸入
const DEFAULT_API_URL = 'https://script.google.com/macros/s/AKfycby0mqrrB5emC0J1ehg7HNQZHXKacUvLD2fAliPYjlCESApO-OzILD3ehjRneiw_UD-B/exec';

const STORAGE_KEYS = {
  API_URL: 'taskflow_gas_api_url',
  TOKEN: 'taskflow_session_token'
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
  activeView: 'kanban',
  editingTaskId: null
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

  if (state.token && state.apiUrl) {
    loadBootstrap();
  }
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
      statusEl.textContent = `✅ ${res.message}`;
    } catch (err) {
      statusEl.textContent = `❌ ${err.message}`;
    }
  });

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('login-submit-btn');
    btn.disabled = true;
    btn.textContent = '登入中...';
    try {
      const username = document.getElementById('login-username').value.trim();
      const password = document.getElementById('login-password').value;
      const res = await callApi('login', { username, password });
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
  state.token = '';
  state.currentUser = null;
  sessionStorage.removeItem(STORAGE_KEYS.TOKEN);
  localStorage.removeItem(STORAGE_KEYS.TOKEN);
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
}

async function loadBootstrap() {
  try {
    const data = await callApi('getBootstrap');
    state.currentUser = data.currentUser;
    state.users = data.users || [];
    state.tasks = data.tasks || [];
    state.subtasks = data.subtasks || [];
    state.attachments = data.attachments || [];
    state.comments = data.comments || [];
    state.notifications = data.notifications || [];

    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');
    renderHeaderAndFilters();
    renderActiveView();
    renderNotifications();
  } catch (err) {
    showToast(err.message, 'error');
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
      renderActiveView();
    });
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
    if (assignee && t.assignee_id !== assignee) return false;
    if (onlyMine && t.assignee_id !== state.currentUser.user_id) return false;
    if (q) {
      const hay = `${t.title} ${t.description} ${(t.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderActiveView() {
  document.getElementById('view-kanban').classList.toggle('hidden', state.activeView !== 'kanban');
  document.getElementById('view-list').classList.toggle('hidden', state.activeView !== 'list');
  document.getElementById('view-admin').classList.toggle('hidden', state.activeView !== 'admin');
  document.getElementById('filter-bar').classList.toggle('hidden', state.activeView === 'admin');

  const filtered = getFilteredTasks();
  document.getElementById('filter-summary').textContent = `共 ${filtered.length} 項任務`;

  if (state.activeView === 'kanban') renderKanban(filtered);
  else if (state.activeView === 'list') renderListView(filtered);
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
  const assignee = getUserName(t.assignee_id);
  const subs = state.subtasks.filter(s => s.task_id === t.task_id);
  const subDone = subs.filter(s => s.is_done).length;
  const attCount = state.attachments.filter(a => a.task_id === t.task_id).length;
  const cmtCount = state.comments.filter(c => c.task_id === t.task_id).length;
  const isOverdue = t.due_date && t.due_date < today && t.status !== 'done';
  const priorityClass = VALID_PRIORITIES.has(t.priority) ? t.priority : 'medium';

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
        <td>${escapeHtml(getUserName(t.assignee_id))}</td>
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
  document.getElementById('close-task-modal').addEventListener('click', () => {
    document.getElementById('task-modal').classList.add('hidden');
  });

  document.getElementById('task-form').addEventListener('submit', async e => {
    e.preventDefault();
    const saveBtn = document.getElementById('save-task-btn');
    saveBtn.disabled = true;
    try {
      const payload = {
        title: document.getElementById('task-title-input').value.trim(),
        description: document.getElementById('task-desc-input').value.trim(),
        status: document.getElementById('task-status-input').value,
        priority: document.getElementById('task-priority-input').value,
        assignee_id: document.getElementById('task-assignee-input').value,
        department: document.getElementById('task-dept-input').value.trim(),
        start_date: document.getElementById('task-start-input').value,
        due_date: document.getElementById('task-due-input').value,
        recurrence: document.getElementById('task-recurrence-input').value,
        tags: document.getElementById('task-tags-input').value.split(',').map(s => s.trim()).filter(Boolean),
        estimated_hours: Number(document.getElementById('task-est-hours-input').value || 0)
      };

      if (state.editingTaskId) {
        payload.task_id = state.editingTaskId;
        const res = await callApi('updateTask', payload);
        const idx = state.tasks.findIndex(t => t.task_id === state.editingTaskId);
        if (idx !== -1) state.tasks[idx] = res.task;
        if (res.nextRecurringTask) state.tasks.unshift(res.nextRecurringTask);
        showToast('任務已更新', 'success');
      } else {
        const res = await callApi('createTask', payload);
        state.tasks.unshift(res.task);
        state.editingTaskId = res.task.task_id;
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
}

function openTaskModal(taskId) {
  state.editingTaskId = taskId;
  const assigneeSelect = document.getElementById('task-assignee-input');
  assigneeSelect.innerHTML = state.users.filter(u => u.status === 'active')
    .map(u => `<option value="${escapeHtml(u.user_id)}">${escapeHtml(u.display_name)} (${escapeHtml(u.department)})</option>`)
    .join('');

  const task = taskId ? state.tasks.find(t => t.task_id === taskId) : null;
  document.getElementById('task-modal-title').textContent = task ? '編輯任務' : '新增任務';
  document.getElementById('task-id-input').value = task ? task.task_id : '';
  document.getElementById('task-title-input').value = task ? task.title : '';
  document.getElementById('task-desc-input').value = task ? task.description : '';
  document.getElementById('task-status-input').value = task ? task.status : 'todo';
  document.getElementById('task-priority-input').value = task ? task.priority : 'medium';
  assigneeSelect.value = task ? task.assignee_id : state.currentUser.user_id;
  document.getElementById('task-dept-input').value = task ? task.department : state.currentUser.department;
  document.getElementById('task-start-input').value = task ? (task.start_date || '') : '';
  document.getElementById('task-due-input').value = task ? (task.due_date || '') : '';
  document.getElementById('task-recurrence-input').value = task ? (task.recurrence || 'none') : 'none';
  document.getElementById('task-tags-input').value = task ? (task.tags || []).join(', ') : '';
  document.getElementById('task-est-hours-input').value = task ? (task.estimated_hours || 0) : 0;

  document.getElementById('archive-task-btn').classList.toggle('hidden', !task);
  document.getElementById('task-collab-sections').classList.toggle('hidden', !task);

  if (task) renderTaskCollabSections(task.task_id);
  document.getElementById('task-modal').classList.remove('hidden');
}

function renderTaskCollabSections(taskId) {
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