/* ==========================================================================
   InkVoucher - Javascript Engine
   ========================================================================== */

// --- Constants & State ---
let currentVouchers = [];
let activeVoucher = null;
let nextSequenceNumber = 1;
let currentSearchQuery = '';
let currentStatusFilter = 'all'; // all | active | paid | unpaid | void
let currentDateRange = null; // null = All Dates, else {from, to} yyyy-mm-dd -- Ledger History's own date filter, independent of the Dashboard's
let currentSettlementFilter = ''; // '' = All, else 'Not Received' | 'Received'
let currentOwnerFilter = ''; // '' = All Owners, else an owners.id
let currentStaffFilter = ''; // '' = All Staff, else a profiles.id
let isSaving = false;
let companySettings = null;

// Current user's identity/role (Owner/Admin vs Staff) -- loaded once at
// startup from profiles.role. The backend RPCs re-check this independently
// (see supabase/schema.sql) -- this copy only drives which controls the UI
// shows; it is never the actual enforcement.
let currentUserId = null;
let currentUserRole = 'staff';
function isOwnerAdmin() {
  return currentUserRole === 'owner_admin';
}

// Owners (Owner Management) and Staff (profiles) caches -- small, shared
// lookup tables loaded once at startup and refreshed after edits, used to
// populate filter/assignment dropdowns and to resolve a settlement's
// owner/recorded-by id into a display name without a round trip per voucher.
let allOwners = [];
let ownersById = new Map();
let allProfiles = [];
let profilesById = new Map();
let editingOwnerId = null;

// Drawing states
let isDrawing = false;
// Dedicated lock for scaleVoucherToFit() -- true for the entire span of a
// pointerdown-to-pointerup/pointercancel stroke (not pointerleave, which
// isDrawing also reacts to). scaleVoucherToFit() itself refuses to run
// while this is true, no matter which event path called it.
let isDrawingActive = false;
let pendingRescale = false; // a rescale was requested mid-stroke -- run it once isDrawingActive clears
let lastStrokeEndTime = 0; // Date.now() of the last pointerup/pointerleave -- see handleResize()
let lastX = 0;
let lastY = 0;
let penColor = '#1d4ed8'; // Default blue ink
let penWidth = 2.5;
let activeTool = 'pencil'; // pencil or eraser

// Canvas tracking (9 canvases total)
const rowCanvases = document.querySelectorAll('.row-canvas');
const sigCanvas = document.getElementById('sig-canvas');
const allCanvases = [...rowCanvases, sigCanvas];

// Cache context maps for all canvases
const canvasCtxs = new Map();

// Vector stroke data per canvas -- the source of truth behind the rendered
// PNG, so the voucher can be regenerated/redesigned later without being
// limited to a flattened image.
const canvasStrokes = new Map();
allCanvases.forEach((c) => canvasStrokes.set(c, []));
let currentStroke = null;

// DOM Elements
const paperVoucher = document.getElementById('paper-voucher');
const clearDrawingsBtn = document.getElementById('clear-drawings-btn');
const clearAllBtn = document.getElementById('clear-all-btn');
const brushSizeSlider = document.getElementById('brush-size');
const brushSizeVal = document.getElementById('brush-size-val');
const colorButtons = document.querySelectorAll('.color-btn');
const toolRadios = document.querySelectorAll('input[name="active-tool"]');
const colorPickerGroup = document.getElementById('color-picker-group');
const colorDivider = document.getElementById('color-divider');
const voucherDateInput = document.getElementById('voucher-date');
const voucherList = document.getElementById('voucher-list');
const emptyHistory = document.getElementById('empty-history');
const searchInput = document.getElementById('search-input');
const searchClearBtn = document.getElementById('search-clear-btn');
const filterChipRow = document.getElementById('filter-chip-row');
const resultCountEl = document.getElementById('result-count');
const ledgerDateFilter = document.getElementById('ledger-date-filter');
const ledgerDateClearBtn = document.getElementById('ledger-date-clear-btn');
const ledgerDateCustomRow = document.getElementById('ledger-date-custom-row');
const ledgerDateFrom = document.getElementById('ledger-date-from');
const ledgerDateTo = document.getElementById('ledger-date-to');
const ledgerDateApplyBtn = document.getElementById('ledger-date-apply-btn');
const ledgerSettlementFilter = document.getElementById('ledger-settlement-filter');
const ledgerOwnerFilter = document.getElementById('ledger-owner-filter');
const ledgerStaffFilter = document.getElementById('ledger-staff-filter');
const customerNameInput = document.getElementById('customer-name-input');
const customerPhoneInput = document.getElementById('customer-phone-input');
const saveOnlyBtn = document.getElementById('save-only-btn');
const savePrintBtn = document.getElementById('save-print-btn');

// Sidebar toggles
const sidebar = document.getElementById('sidebar');
const hideSidebarBtn = document.getElementById('hide-sidebar-btn');
const showSidebarBtn = document.getElementById('show-sidebar-btn');

// Auth Elements
const authOverlay = document.getElementById('auth-overlay');
const appContainer = document.getElementById('app-container');
const loginForm = document.getElementById('login-form');
const loginEmailInput = document.getElementById('login-email');
const loginPasswordInput = document.getElementById('login-password');
const loginBtn = document.getElementById('login-btn');
const authErrorEl = document.getElementById('auth-error');
const logoutBtn = document.getElementById('logout-btn');

// Modal Elements
const detailModal = document.getElementById('detail-modal');
const closeModalBtn = document.getElementById('close-modal-btn');
const modalVoucherId = document.getElementById('modal-voucher-id');
const modalVoucherDate = document.getElementById('modal-voucher-date');
const modalCustomerName = document.getElementById('modal-customer-name');
const modalPaymentBadge = document.getElementById('modal-payment-badge');
const modalStatusBadge = document.getElementById('modal-status-badge');
const modalVoucherImg = document.getElementById('modal-voucher-img');
const modalVoidOverlay = document.getElementById('modal-void-overlay');
const voidBtn = document.getElementById('void-btn');
const downloadBtn = document.getElementById('download-btn');
const markPaidBtn = document.getElementById('mark-paid-btn');
const markUnpaidBtn = document.getElementById('mark-unpaid-btn');
const printBtn = document.getElementById('print-btn');

// Owner Settlement Elements (voucher detail modal)
const modalSettlementBadge = document.getElementById('modal-settlement-badge');
const modalSettlementDetail = document.getElementById('modal-settlement-detail');
const modalSettlementActions = document.getElementById('modal-settlement-actions');
const settlementReceiveRow = document.getElementById('settlement-receive-row');
const settlementOwnerSelect = document.getElementById('settlement-owner-select');
const markSettlementReceivedBtn = document.getElementById('mark-settlement-received-btn');
const markSettlementNotReceivedBtn = document.getElementById('mark-settlement-not-received-btn');

// Owner Management Elements
const openOwnerMgmtBtn = document.getElementById('open-owner-mgmt-btn');
const ownerMgmtModal = document.getElementById('owner-mgmt-modal');
const closeOwnerMgmtBtn = document.getElementById('close-owner-mgmt-btn');
const ownerAddForm = document.getElementById('owner-add-form');
const ownerAddNameInput = document.getElementById('owner-add-name-input');
const ownerListEl = document.getElementById('owner-list');
const ownerListLoading = document.getElementById('owner-list-loading');

// Dashboard Elements
const openDashboardBtn = document.getElementById('open-dashboard-btn');
const dashboardModal = document.getElementById('dashboard-modal');
const closeDashboardBtn = document.getElementById('close-dashboard-btn');
const dashboardRangeControl = document.getElementById('dashboard-range-control');
const dashboardCustomRange = document.getElementById('dashboard-custom-range');
const dashboardDateFrom = document.getElementById('dashboard-date-from');
const dashboardDateTo = document.getElementById('dashboard-date-to');
const dashboardCustomApplyBtn = document.getElementById('dashboard-custom-apply-btn');
const dashboardLoading = document.getElementById('dashboard-loading');
const dashboardContent = document.getElementById('dashboard-content');
const dashTotalVouchers = document.getElementById('dash-total-vouchers');
const dashTotalAmount = document.getElementById('dash-total-amount');
const dashPaidAmount = document.getElementById('dash-paid-amount');
const dashUnpaidAmount = document.getElementById('dash-unpaid-amount');
const dashboardMethodGrid = document.getElementById('dashboard-method-grid');
const dashHighestVoucher = document.getElementById('dash-highest-voucher');
const dashAverageVoucher = document.getElementById('dash-average-voucher');
const dashLatestVoucher = document.getElementById('dash-latest-voucher');
const dashboardOutstandingList = document.getElementById('dashboard-outstanding-list');

// --- Supabase Data Access ---

// Maps a status filter chip to the search_vouchers params that implement it.
// Paid/Unpaid implicitly exclude Void vouchers -- a voided sale isn't
// meaningfully "paid" or "owed" in the business sense, it's cancelled.
function filterToSearchParams(filter) {
  switch (filter) {
    case 'active': return { p_voucher_status: 'Active' };
    case 'void': return { p_voucher_status: 'Void' };
    case 'paid': return { p_voucher_status: 'Active', p_payment_status: 'Paid' };
    case 'unpaid': return { p_voucher_status: 'Active', p_payment_status: 'Unpaid' };
    default: return {};
  }
}

// Shop letterhead (name/address/phone/logo) shown on the printed voucher.
// A single shared row -- there's only one shop, so no id parameter needed
// beyond the fixed singleton row.
async function loadCompanySettings() {
  const { data, error } = await supabaseClient.from('company_settings').select('*').eq('id', 1).maybeSingle();
  if (error) {
    console.error('Failed to load company settings:', error);
    return null;
  }
  return data;
}

// Determines whether the logged-in user can manage owners and update Owner
// Settlement (the actual permission gate is server-side -- see is_owner_admin()
// in supabase/schema.sql -- this only decides which controls the UI shows).
async function loadCurrentUserProfile() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return null;
  currentUserId = user.id;

  const { data, error } = await supabaseClient.from('profiles').select('id, name, role').eq('id', user.id).maybeSingle();
  if (error) {
    console.error('Failed to load current user profile:', error);
    return null;
  }
  currentUserRole = (data && data.role) || 'staff';
  return data;
}

// Owner Management entities -- distinct from app logins. Loaded in full
// (active + disabled) so the Owner Management list and the "Received By"
// ledger filter can show every owner ever recorded; only active owners are
// offered in the settlement assignment dropdown (see getActiveOwners()).
async function loadOwners() {
  const { data, error } = await supabaseClient.from('owners').select('*').order('name');
  if (error) {
    console.error('Failed to load owners:', error);
    return;
  }
  allOwners = data || [];
  ownersById = new Map(allOwners.map((o) => [o.id, o]));
}

function getActiveOwners() {
  return allOwners.filter((o) => o.active);
}

// Staff directory (profiles) -- used for the Ledger's "Staff" filter and to
// resolve a settlement's "recorded by" id into a display name.
async function loadProfiles() {
  const { data, error } = await supabaseClient.from('profiles').select('id, name, role').order('name');
  if (error) {
    console.error('Failed to load staff list:', error);
    return;
  }
  allProfiles = data || [];
  profilesById = new Map(allProfiles.map((p) => [p.id, p]));
}

function populateOwnerFilterSelect() {
  ledgerOwnerFilter.innerHTML = '<option value="">All Owners</option>' +
    allOwners.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}${o.active ? '' : ' (disabled)'}</option>`).join('');
  ledgerOwnerFilter.value = currentOwnerFilter;
}

function populateStaffFilterSelect() {
  ledgerStaffFilter.innerHTML = '<option value="">All Staff</option>' +
    allProfiles.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  ledgerStaffFilter.value = currentStaffFilter;
}

function populateSettlementOwnerSelect() {
  settlementOwnerSelect.innerHTML = '<option value="">Select owner…</option>' +
    getActiveOwners().map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('');
}

// Re-fetches the ledger from the server using the current search text,
// status filter chip, and date filter. Server-side rather than filtering
// the local cache, so filters stay correct even when there are more
// vouchers than the page size.
async function reloadVouchers() {
  voucherList.innerHTML = '<div class="list-loading">Loading vouchers…</div>';
  const params = { p_limit: 50, ...filterToSearchParams(currentStatusFilter) };
  if (currentSearchQuery) params.p_q = currentSearchQuery;
  if (currentDateRange) {
    params.p_date_from = currentDateRange.from;
    params.p_date_to = currentDateRange.to;
  }
  if (currentSettlementFilter) params.p_settlement_status = currentSettlementFilter;
  if (currentOwnerFilter) params.p_received_by_owner = currentOwnerFilter;
  if (currentStaffFilter) params.p_created_by = currentStaffFilter;

  const { data, error } = await supabaseClient.rpc('search_vouchers', params);
  if (error) {
    console.error('Failed to load vouchers:', error);
    showToast('Failed to load ledger: ' + describeRpcError(error), 'error');
    currentVouchers = [];
    await renderVoucherList(currentVouchers);
    return;
  }
  currentVouchers = data || [];
  await renderVoucherList(currentVouchers);
}

// Maps known Postgres/PostgREST error codes (see supabase/schema.sql) to a
// message a staff member can actually act on.
function describeRpcError(error) {
  if (!error) return 'Unknown error.';
  if (error.code === '23514') return 'This voucher is voided -- it can no longer be changed.';
  if (error.code === 'P0002') return 'Not found.';
  if (error.code === '28000') return 'You need to be logged in to do that.';
  if (error.code === '42501') return 'Only Owner/Admin can do that.';
  return error.message || 'Something went wrong.';
}

// --- Dashboard ---

const fmtMoney = (n) => '$' + Number(n || 0).toFixed(2);

// Local (not UTC) yyyy-mm-dd, matching loadCurrentDate() -- toISOString()
// would shift the date near midnight in timezones ahead of UTC.
function toLocalISODate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Returns {from, to} for a preset, or null for 'custom'/'all' (caller reads
// the date inputs directly, or applies no date filter, instead). Shared by
// the Dashboard and the Ledger History date filter. "This Week" starts
// Monday; both week and month presets run through today, not the literal
// end of the period.
function getDateRangeForPreset(preset) {
  const today = new Date();
  if (preset === 'today') {
    const d = toLocalISODate(today);
    return { from: d, to: d };
  }
  if (preset === 'yesterday') {
    const y = new Date(today);
    y.setDate(y.getDate() - 1);
    const d = toLocalISODate(y);
    return { from: d, to: d };
  }
  if (preset === 'week') {
    const dow = today.getDay(); // 0 = Sunday .. 6 = Saturday
    const diffToMonday = dow === 0 ? 6 : dow - 1;
    const monday = new Date(today);
    monday.setDate(monday.getDate() - diffToMonday);
    return { from: toLocalISODate(monday), to: toLocalISODate(today) };
  }
  if (preset === 'month') {
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: toLocalISODate(first), to: toLocalISODate(today) };
  }
  return null;
}

// Sane starting point for the custom-range inputs so switching to "Custom"
// doesn't present two empty date fields.
dashboardDateFrom.value = toLocalISODate(new Date());
dashboardDateTo.value = toLocalISODate(new Date());

function openDashboard() {
  dashboardModal.classList.add('active');
  loadDashboard();
}

function closeDashboard() {
  dashboardModal.classList.remove('active');
}

async function loadDashboard() {
  const preset = dashboardRangeControl.querySelector('input[name="dashboard-range"]:checked').value;
  let range;
  if (preset === 'custom') {
    if (!dashboardDateFrom.value || !dashboardDateTo.value) return; // wait for both custom dates
    range = { from: dashboardDateFrom.value, to: dashboardDateTo.value };
  } else {
    range = getDateRangeForPreset(preset);
  }

  dashboardLoading.hidden = false;
  dashboardContent.hidden = true;

  const { data, error } = await supabaseClient.rpc('get_dashboard_summary', {
    p_date_from: range.from,
    p_date_to: range.to,
  });

  dashboardLoading.hidden = true;
  dashboardContent.hidden = false;

  if (error) {
    console.error('Failed to load dashboard:', error);
    showToast('Failed to load dashboard: ' + describeRpcError(error), 'error');
    return;
  }
  renderDashboardData(data);
}

function renderDashboardData(data) {
  const summary = data.summary || {};
  dashTotalVouchers.textContent = summary.total_vouchers || 0;
  dashTotalAmount.textContent = fmtMoney(summary.total_amount);
  dashPaidAmount.textContent = fmtMoney(summary.paid_amount);
  dashUnpaidAmount.textContent = fmtMoney(summary.unpaid_amount);

  const byMethod = new Map((data.payment_breakdown || []).map((m) => [m.payment_method, m]));
  dashboardMethodGrid.innerHTML = ['Cash', 'Transfer', 'PayNow'].map((method) => {
    const m = byMethod.get(method) || { voucher_count: 0, amount: 0 };
    return `
      <div class="dashboard-method-card">
        <span class="dashboard-card-label">${method}</span>
        <span class="dashboard-card-value">${fmtMoney(m.amount)}</span>
        <span class="dashboard-outstanding-count">${m.voucher_count} voucher${m.voucher_count === 1 ? '' : 's'}</span>
      </div>
    `;
  }).join('');

  const highest = data.highest_voucher;
  dashHighestVoucher.textContent = highest
    ? `${formatVoucherID(highest.sequence_number)} -- ${fmtMoney(highest.total_amount)}`
    : '--';

  dashAverageVoucher.textContent = summary.total_vouchers ? fmtMoney(summary.average_amount) : '--';

  const latest = data.latest_voucher;
  dashLatestVoucher.textContent = latest
    ? `${formatVoucherID(latest.sequence_number)} -- ${latest.customer_name}`
    : '--';

  const outstanding = data.outstanding_customers || [];
  dashboardOutstandingList.innerHTML = outstanding.length
    ? outstanding.map((c) => `
        <div class="dashboard-outstanding-row" data-name="${escapeHtml(c.customer_name)}" data-phone="${escapeHtml(c.customer_phone || '')}">
          <div>
            <span class="dashboard-outstanding-name">${escapeHtml(c.customer_name)}</span>
            ${c.customer_phone ? `<span class="dashboard-outstanding-phone">${escapeHtml(c.customer_phone)}</span>` : ''}
          </div>
          <div class="dashboard-outstanding-meta">
            <span class="dashboard-outstanding-amount">${fmtMoney(c.outstanding_amount)}</span>
            <span class="dashboard-outstanding-count">${c.voucher_count} voucher${c.voucher_count === 1 ? '' : 's'}</span>
          </div>
        </div>
      `).join('')
    : '<div class="dashboard-empty-row">No outstanding vouchers.</div>';
}

// Closes the dashboard and re-runs the existing server-side ledger search
// filtered to this one customer, reusing the same currentSearchQuery/
// currentStatusFilter mechanism the search box and filter chips already
// drive -- no separate filtering path needed.
function jumpToCustomerLedger(customerName, customerPhone) {
  closeDashboard();

  currentStatusFilter = 'unpaid';
  filterChipRow.querySelectorAll('.filter-chip').forEach((c) => c.classList.remove('active'));
  const unpaidChip = filterChipRow.querySelector('.filter-chip[data-filter="unpaid"]');
  if (unpaidChip) unpaidChip.classList.add('active');

  currentSearchQuery = (customerPhone || customerName || '').toLowerCase().trim();
  searchInput.value = customerPhone || customerName || '';
  searchClearBtn.hidden = !currentSearchQuery;

  if (window.innerWidth <= SIDEBAR_BREAKPOINT) {
    sidebar.classList.remove('collapsed');
    showSidebarBtn.style.display = 'none';
  }

  reloadVouchers();
}

async function getSignedImageUrl(path) {
  if (!path) return '';
  const { data, error } = await supabaseClient.storage.from('voucher-images').createSignedUrl(path, 300);
  if (error) {
    console.error('Failed to sign image URL:', error);
    return '';
  }
  return data.signedUrl;
}

// Batched variant for rendering the whole sidebar in one round trip instead
// of one signed-URL request per voucher card.
async function getSignedImageUrls(paths) {
  const map = new Map();
  if (paths.length === 0) return map;
  const { data, error } = await supabaseClient.storage.from('voucher-images').createSignedUrls(paths, 300);
  if (error) {
    console.error('Failed to sign image URLs:', error);
    return map;
  }
  data.forEach((item, idx) => {
    if (item.signedUrl) map.set(paths[idx], item.signedUrl);
  });
  return map;
}

// Mirrors filterToSearchParams locally, so a single patched voucher can be
// dropped from view immediately if it no longer matches the active filter
// (e.g. marking something Paid while viewing the "Unpaid" chip).
function matchesCurrentFilters(v) {
  if (currentStatusFilter === 'active' && v.voucher_status !== 'Active') return false;
  if (currentStatusFilter === 'void' && v.voucher_status !== 'Void') return false;
  if (currentStatusFilter === 'paid' && (v.voucher_status === 'Void' || v.payment_status !== 'Paid')) return false;
  if (currentStatusFilter === 'unpaid' && (v.voucher_status === 'Void' || v.payment_status !== 'Unpaid')) return false;

  if (currentDateRange && (v.date < currentDateRange.from || v.date > currentDateRange.to)) return false;

  if (currentSettlementFilter && v.settlement_status !== currentSettlementFilter) return false;
  if (currentOwnerFilter && v.settlement_received_by !== currentOwnerFilter) return false;
  if (currentStaffFilter && v.created_by !== currentStaffFilter) return false;

  if (currentSearchQuery) {
    const q = currentSearchQuery;
    const displayId = formatVoucherID(v.sequence_number).toLowerCase();
    const matchesText = displayId.includes(q)
      || (v.customer_name || '').toLowerCase().includes(q)
      || (v.customer_phone || '').toLowerCase().includes(q)
      || v.payment_method.toLowerCase().includes(q)
      || v.date.includes(q);
    if (!matchesText) return false;
  }
  return true;
}

// After mark-paid/unpaid/void/print, patch the one changed voucher into local
// state from the RPC's response instead of refetching the whole list.
function patchVoucherInLocalState(updated) {
  const idx = currentVouchers.findIndex(v => v.id === updated.id);
  if (idx === -1) return;
  if (matchesCurrentFilters(updated)) {
    currentVouchers[idx] = updated;
  } else {
    currentVouchers.splice(idx, 1);
  }
  renderVoucherList(currentVouchers);
}

// Single source of truth for how Paid/Unpaid/Void render, shared by the
// ledger cards and the detail modal so status always looks the same way.
function getStatusBadgeInfo(voucher) {
  if (voucher.voucher_status === 'Void') return { label: 'Void', className: 'is-void' };
  if (voucher.payment_status === 'Paid') return { label: 'Paid', className: 'is-paid' };
  return { label: 'Unpaid', className: 'is-unpaid' };
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- Owner Management (Owner/Admin only -- enforced server-side too) ---

async function openOwnerMgmt() {
  ownerMgmtModal.classList.add('active');
  editingOwnerId = null;
  ownerListLoading.hidden = false;
  await loadOwners();
  ownerListLoading.hidden = true;
  renderOwnerList(allOwners);
}

function closeOwnerMgmt() {
  ownerMgmtModal.classList.remove('active');
  editingOwnerId = null;
}

// Owners never disappear from disk (disable, not delete -- see set_owner_active
// in supabase/schema.sql), so the list always shows everyone who was ever
// added; a status-pill marks which ones are currently active.
function renderOwnerList(owners) {
  ownerListEl.querySelectorAll('.owner-row, .owner-edit-form, .owner-empty-row').forEach((el) => el.remove());

  if (owners.length === 0) {
    ownerListEl.insertAdjacentHTML('beforeend', '<div class="owner-empty-row">No owners yet. Add one above.</div>');
    return;
  }

  owners.forEach((o) => {
    if (editingOwnerId === o.id) {
      ownerListEl.insertAdjacentHTML('beforeend', `
        <form class="owner-edit-form" data-owner-id="${o.id}">
          <input type="text" class="owner-edit-input" value="${escapeHtml(o.name)}" required>
          <button type="submit" class="btn btn-secondary">Save</button>
          <button type="button" class="btn btn-secondary owner-cancel-edit-btn">Cancel</button>
        </form>
      `);
      return;
    }

    ownerListEl.insertAdjacentHTML('beforeend', `
      <div class="owner-row" data-owner-id="${o.id}">
        <div class="owner-row-info">
          <span class="owner-row-name">${escapeHtml(o.name)}</span>
          <span class="status-pill sm ${o.active ? 'is-paid' : 'is-void'}">${o.active ? 'Active' : 'Disabled'}</span>
        </div>
        <div class="owner-row-actions">
          <button class="btn btn-secondary owner-edit-btn" data-owner-id="${o.id}">Edit</button>
          <button class="btn btn-secondary ${o.active ? 'text-danger' : ''} owner-toggle-btn" data-owner-id="${o.id}" data-active="${o.active}">${o.active ? 'Disable' : 'Enable'}</button>
        </div>
      </div>
    `);
  });
}

// Refreshes every place the owners cache feeds: the management list itself,
// the Ledger's "Received By" filter, and the settlement assignment dropdown
// (only the latter is currently open/visible, but it's cheap to keep fresh).
async function refreshOwnersEverywhere() {
  await loadOwners();
  renderOwnerList(allOwners);
  populateOwnerFilterSelect();
  populateSettlementOwnerSelect();
}

ownerAddForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = ownerAddNameInput.value.trim();
  if (!name) return;

  const submitBtn = ownerAddForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  const { data, error } = await supabaseClient.rpc('add_owner', { p_name: name });
  submitBtn.disabled = false;

  if (error) {
    console.error('Failed to add owner:', error);
    showToast('Failed to add owner: ' + describeRpcError(error), 'error');
    return;
  }

  ownerAddNameInput.value = '';
  await refreshOwnersEverywhere();
  showToast(`Owner "${data.name}" added.`, 'success');
});

ownerListEl.addEventListener('click', async (e) => {
  const editBtn = e.target.closest('.owner-edit-btn');
  if (editBtn) {
    editingOwnerId = editBtn.dataset.ownerId;
    renderOwnerList(allOwners);
    return;
  }

  const cancelBtn = e.target.closest('.owner-cancel-edit-btn');
  if (cancelBtn) {
    editingOwnerId = null;
    renderOwnerList(allOwners);
    return;
  }

  const toggleBtn = e.target.closest('.owner-toggle-btn');
  if (toggleBtn) {
    const ownerId = toggleBtn.dataset.ownerId;
    const isActive = toggleBtn.dataset.active === 'true';
    const owner = ownersById.get(ownerId);
    const verb = isActive ? 'disable' : 're-enable';
    const ok = await showConfirm(
      `Are you sure you want to ${verb} owner "${owner ? owner.name : ''}"?`,
      { confirmLabel: isActive ? 'Disable' : 'Enable', danger: isActive }
    );
    if (!ok) return;

    toggleBtn.disabled = true;
    const { data, error } = await supabaseClient.rpc('set_owner_active', { p_owner_id: ownerId, p_active: !isActive });
    toggleBtn.disabled = false;

    if (error) {
      console.error('Failed to update owner:', error);
      showToast('Failed to update owner: ' + describeRpcError(error), 'error');
      return;
    }

    await refreshOwnersEverywhere();
    showToast(`Owner "${data.name}" ${data.active ? 'enabled' : 'disabled'}.`, 'success');
  }
});

ownerListEl.addEventListener('submit', async (e) => {
  const form = e.target.closest('.owner-edit-form');
  if (!form) return;
  e.preventDefault();

  const ownerId = form.dataset.ownerId;
  const input = form.querySelector('.owner-edit-input');
  const name = input.value.trim();
  if (!name) return;

  const { data, error } = await supabaseClient.rpc('update_owner', { p_owner_id: ownerId, p_name: name });
  if (error) {
    console.error('Failed to update owner:', error);
    showToast('Failed to update owner: ' + describeRpcError(error), 'error');
    return;
  }

  editingOwnerId = null;
  await refreshOwnersEverywhere();
  showToast(`Owner renamed to "${data.name}".`, 'success');
});

openOwnerMgmtBtn.addEventListener('click', openOwnerMgmt);
closeOwnerMgmtBtn.addEventListener('click', closeOwnerMgmt);
markSettlementReceivedBtn.addEventListener('click', handleMarkSettlementReceived);
markSettlementNotReceivedBtn.addEventListener('click', handleMarkSettlementNotReceived);

// --- Toast notifications (replaces window.alert for success/error feedback) ---
const toastContainer = document.getElementById('toast-container');
function showToast(message, type = 'success', duration = 3500) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// --- Custom confirm dialog (replaces window.confirm) ---
const confirmOverlay = document.getElementById('confirm-overlay');
const confirmMessageEl = document.getElementById('confirm-message');
const confirmOkBtn = document.getElementById('confirm-ok-btn');
const confirmCancelBtn = document.getElementById('confirm-cancel-btn');

function showConfirm(message, { confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    confirmMessageEl.textContent = message;
    confirmOkBtn.textContent = confirmLabel;
    confirmOkBtn.classList.toggle('btn-danger', danger);
    confirmOkBtn.classList.toggle('btn-primary', !danger);
    confirmOverlay.hidden = false;

    function cleanup(result) {
      confirmOverlay.hidden = true;
      confirmOkBtn.removeEventListener('click', onOk);
      confirmCancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    confirmOkBtn.addEventListener('click', onOk);
    confirmCancelBtn.addEventListener('click', onCancel);
  });
}

// --- Synthesized "Paper Tear" Sound System ---
function playTearSound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    
    const audioCtx = new AudioContext();
    const duration = 0.45; // seconds
    const sampleRate = audioCtx.sampleRate;
    const bufferSize = sampleRate * duration;
    const buffer = audioCtx.createBuffer(1, bufferSize, sampleRate);
    const data = buffer.getChannelData(0);
    
    for (let i = 0; i < bufferSize; i++) {
      let noise = Math.random() * 2 - 1;
      const progress = i / bufferSize;
      const fiberTearFreq = Math.sin(progress * 130) * Math.cos(progress * 45);
      if (Math.abs(fiberTearFreq) > 0.75) {
        noise += (Math.random() * 2 - 1) * 0.6; // Crackles
      }
      data[i] = noise;
    }
    
    const noiseNode = audioCtx.createBufferSource();
    noiseNode.buffer = buffer;
    
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(2600, audioCtx.currentTime);
    filter.Q.setValueAtTime(1.8, audioCtx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(750, audioCtx.currentTime + duration);
    
    const gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(0.01, audioCtx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.18, audioCtx.currentTime + 0.05);
    
    // Fiber tearing variations
    for (let t = 0.05; t < duration; t += 0.015) {
      const volume = 0.08 + Math.random() * 0.09;
      gainNode.gain.setValueAtTime(volume, audioCtx.currentTime + t);
    }
    
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    
    noiseNode.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    noiseNode.start();
    
    setTimeout(() => {
      audioCtx.close();
    }, (duration + 0.1) * 1000);
  } catch (error) {
    console.warn('Paper tear audio synthesis failed:', error);
  }
}

// --- Multi-Canvas Drawing Engine ---
function resizeAndScaleCanvases() {
  allCanvases.forEach((canvasElement) => {
    const rect = canvasElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const targetWidth = Math.round(rect.width * dpr);
    const targetHeight = Math.round(rect.height * dpr);

    // Skip canvases whose backing store already matches -- avoids wiping and
    // redrawing every stroke when a resize event (e.g. iOS Safari's chrome
    // bar collapsing) doesn't actually change this canvas's on-screen size.
    if (canvasElement.width === targetWidth && canvasElement.height === targetHeight) {
      return;
    }

    // Cache current drawing state
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvasElement.width;
    tempCanvas.height = canvasElement.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(canvasElement, 0, 0);

    // Resize backing coordinates
    canvasElement.width = targetWidth;
    canvasElement.height = targetHeight;

    const context = canvasElement.getContext('2d');
    context.scale(dpr, dpr);
    canvasCtxs.set(canvasElement, context);

    // Restore cached lines
    context.imageSmoothingEnabled = true;
    context.drawImage(tempCanvas, 0, 0, rect.width, rect.height);

    // Setup drawing settings
    applyCanvasSettings(context);
  });
}

function applyCanvasSettings(context) {
  context.lineCap = 'round';
  context.lineJoin = 'round';
  if (activeTool === 'eraser') {
    context.globalCompositeOperation = 'destination-out';
    context.strokeStyle = 'rgba(0,0,0,1)'; // Value doesn't matter for destination-out
    context.lineWidth = penWidth * 3.5; // wider eraser for convenience
  } else {
    context.globalCompositeOperation = 'source-over';
    context.strokeStyle = penColor;
    context.lineWidth = penWidth;
  }
}

function updateAllCanvasSettings() {
  allCanvases.forEach((canvasElement) => {
    const context = canvasCtxs.get(canvasElement);
    if (context) {
      applyCanvasSettings(context);
    }
  });
}

function startDrawing(e) {
  const currentCanvas = e.target;
  const context = canvasCtxs.get(currentCanvas);
  if (!context) return;

  isDrawing = true;
  isDrawingActive = true;
  const rect = currentCanvas.getBoundingClientRect();
  const clientX = e.clientX || (e.touches && e.touches[0].clientX);
  const clientY = e.clientY || (e.touches && e.touches[0].clientY);

  lastX = clientX - rect.left;
  lastY = clientY - rect.top;

  currentStroke = { color: penColor, width: penWidth, tool: activeTool, points: [{ x: lastX, y: lastY }] };
  const strokes = canvasStrokes.get(currentCanvas);
  if (strokes) strokes.push(currentStroke);

  // Trigger single pixel/dot drawing immediately on click
  draw(e);
}

function draw(e) {
  if (!isDrawing) return;
  e.preventDefault(); // Palm rejection / prevent scrolling

  const currentCanvas = e.target;
  const context = canvasCtxs.get(currentCanvas);
  if (!context) return;

  const rect = currentCanvas.getBoundingClientRect();
  const clientX = e.clientX || (e.touches && e.touches[0].clientX);
  const clientY = e.clientY || (e.touches && e.touches[0].clientY);

  const x = clientX - rect.left;
  const y = clientY - rect.top;

  context.beginPath();
  context.moveTo(lastX, lastY);
  context.lineTo(x, y);
  context.stroke();

  if (currentStroke) currentStroke.points.push({ x, y });

  lastX = x;
  lastY = y;
}

function stopDrawing() {
  isDrawing = false;
  isDrawingActive = false;
  currentStroke = null;
  lastStrokeEndTime = Date.now();
  if (pendingRescale) {
    pendingRescale = false;
    handleResize(); // re-arms the debounce/quiet-period before actually applying it
  }
}

// Assembles the recorded strokes into the vector source-of-truth stored
// alongside the rendered PNG (see drawing_data in supabase/schema.sql).
function buildDrawingData() {
  const rows = {};
  rowCanvases.forEach((canvas) => {
    rows[canvas.dataset.row] = canvasStrokes.get(canvas) || [];
  });
  return {
    rows,
    signature: canvasStrokes.get(sigCanvas) || [],
  };
}

// Bind event listeners to canvases
function setupCanvasListeners() {
  allCanvases.forEach((canvasElement) => {
    canvasElement.addEventListener('pointerdown', startDrawing);
    canvasElement.addEventListener('pointermove', draw);
    canvasElement.addEventListener('pointerup', stopDrawing);
    canvasElement.addEventListener('pointerleave', stopDrawing);
    // pointercancel fires when the browser/OS hijacks the touch for its own
    // gesture (e.g. starts treating it as a pinch) -- without this, isDrawing
    // and the scale lock could get stuck on, since stopDrawing() would never
    // otherwise run for that stroke.
    canvasElement.addEventListener('pointercancel', stopDrawing);
  });

  // Safari's pinch-zoom gesture is a legacy WebKit-only event that bypasses
  // touch-action entirely -- a resting palm next to the Pencil tip while
  // writing is enough to register as a second touch point and start it,
  // growing the whole page. The viewport meta tag is supposed to disable
  // zoom outright, but this is the documented belt-and-suspenders blocker
  // for it on iPadOS.
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('gesturechange', (e) => e.preventDefault());

  // Row clear buttons
  document.querySelectorAll('.clear-row-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const rowIdx = parseInt(e.target.dataset.row);
      const targetCanvas = document.querySelector(`.row-canvas[data-row="${rowIdx}"]`);
      if (targetCanvas) {
        const context = canvasCtxs.get(targetCanvas);
        if (context) {
          context.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
        }
        canvasStrokes.set(targetCanvas, []);
      }
    });
  });

  // Signature clear button
  document.getElementById('clear-sig-btn').addEventListener('click', () => {
    const context = canvasCtxs.get(sigCanvas);
    if (context) {
      context.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
    }
    canvasStrokes.set(sigCanvas, []);
  });
}

// --- Calculation Engine ---
function setupCalculationEngine() {
  const qtyInputs = document.querySelectorAll('.qty-input');
  const priceInputs = document.querySelectorAll('.price-input');
  
  const recalculateRow = (rowIdx) => {
    const qtyInput = document.querySelector(`.qty-input[data-row="${rowIdx}"]`);
    const priceInput = document.querySelector(`.price-input[data-row="${rowIdx}"]`);
    const amountVal = document.querySelector(`.amount-val[data-row="${rowIdx}"]`);
    
    if (!qtyInput || !priceInput || !amountVal) return;
    
    const qty = parseFloat(qtyInput.value) || 0;
    const price = parseFloat(priceInput.value) || 0;
    const amount = qty * price;
    
    if (qty > 0 && price > 0) {
      amountVal.textContent = amount.toFixed(2);
      amountVal.classList.remove('is-zero');
    } else {
      amountVal.textContent = '';
      amountVal.classList.add('is-zero');
    }
    
    recalculateGrandTotal();
  };
  
  const recalculateGrandTotal = () => {
    let grandTotal = 0;
    document.querySelectorAll('.amount-val').forEach((amountEl) => {
      grandTotal += parseFloat(amountEl.textContent) || 0;
    });
    
    const grandTotalEl = document.getElementById('grand-total-val');
    if (grandTotal > 0) {
      grandTotalEl.textContent = grandTotal.toFixed(2);
      grandTotalEl.classList.remove('is-zero');
    } else {
      grandTotalEl.textContent = '';
      grandTotalEl.classList.add('is-zero');
    }
  };
  
  qtyInputs.forEach((input) => {
    input.addEventListener('input', (e) => {
      const row = e.target.dataset.row;
      recalculateRow(row);
    });
  });
  
  priceInputs.forEach((input) => {
    input.addEventListener('input', (e) => {
      const row = e.target.dataset.row;
      recalculateRow(row);
    });
  });
}

// --- Voucher High-Res Image Composite Compiler ---
function renderCompositeVoucher(sequenceNum, dateString, paymentMethod, status, customerName, customerPhone, rowCanvases, sigCanvas) {
  const companyInfo = {
    name: (companySettings && companySettings.company_name) || 'InkVoucher',
    addressLine: companySettings
      ? [companySettings.address, companySettings.phone].filter(Boolean).join('  ·  ')
      : '',
  };

  return new Promise((resolve) => {
    // 2x Retina Export Size
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = 1160; // 580 * 2
    exportCanvas.height = 1240; // 620 * 2
    const eCtx = exportCanvas.getContext('2d');
    
    // 1. Draw cream yellow carbon paper background
    eCtx.fillStyle = '#fef9c3';
    eCtx.fillRect(0, 0, 1160, 1240);
    
    // Perforation line effect
    eCtx.setLineDash([8, 8]);
    eCtx.strokeStyle = 'rgba(15, 23, 42, 0.2)';
    eCtx.lineWidth = 3;
    eCtx.beginPath();
    eCtx.moveTo(0, 16);
    eCtx.lineTo(1160, 16);
    eCtx.stroke();
    eCtx.setLineDash([]); // reset
    
    // 2. Pre-printed Slip Details
    eCtx.fillStyle = 'rgba(15, 23, 42, 0.85)';

    // Company letterhead (shop identity comes first, like a real business
    // document -- "PAYMENT VOUCHER" is the document type, not the headline)
    eCtx.font = 'bold 22px "Courier Prime", Courier, monospace';
    eCtx.fillText(companyInfo.name, 48, 40);

    if (companyInfo.addressLine) {
      eCtx.font = '12px "Courier Prime", Courier, monospace';
      eCtx.fillStyle = 'rgba(15, 23, 42, 0.6)';
      eCtx.fillText(companyInfo.addressLine, 48, 60);
      eCtx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    }

    eCtx.font = 'bold 28px "Courier Prime", Courier, monospace';
    eCtx.fillText('PAYMENT VOUCHER', 48, 96);

    // Customer (Bill To)
    eCtx.font = '11px "Courier Prime", Courier, monospace';
    eCtx.fillStyle = 'rgba(15, 23, 42, 0.55)';
    eCtx.fillText('BILL TO', 48, 116);

    eCtx.font = 'bold 17px "Courier Prime", Courier, monospace';
    eCtx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    const customerLine = customerPhone ? `${customerName}  ·  ${customerPhone}` : customerName;
    eCtx.fillText(customerLine, 48, 138);

    // Metadata (Voucher ID & Selected Date)
    eCtx.textAlign = 'right';
    eCtx.font = '16px "Courier Prime", Courier, monospace';
    eCtx.fillText('VOUCHER NO.', 1112, 55);
    eCtx.font = 'bold 22px "Courier Prime", Courier, monospace';
    eCtx.fillText(formatVoucherID(sequenceNum), 1112, 80);

    eCtx.font = '16px "Courier Prime", Courier, monospace';
    eCtx.fillText('DATE', 1112, 108);
    eCtx.font = 'bold 18px "Courier Prime", Courier, monospace';
    eCtx.fillText(dateString, 1112, 130);

    eCtx.textAlign = 'left';

    // Header separator line
    eCtx.strokeStyle = 'rgba(15, 23, 42, 0.85)';
    eCtx.lineWidth = 4;
    eCtx.beginPath();
    eCtx.moveTo(48, 156);
    eCtx.lineTo(1112, 156);
    eCtx.stroke();

    // 3. Grid Table Dimensions (bottom edge (984) kept constant vs. the
    // original design so the footer/signature/total layout below is
    // unaffected regardless of how tall the header block above grows)
    const tableTop = 180;
    const tableHeight = 804;
    const tableWidth = 1064; // 1112 - 48
    
    const colDescWidth = 564;
    const colQtyWidth = 120;
    const colPriceWidth = 180;
    const colAmountWidth = 200;
    
    const xDesc = 48;
    const xQty = xDesc + colDescWidth;
    const xPrice = xQty + colQtyWidth;
    const xAmount = xPrice + colPriceWidth;
    
    // Outer border
    eCtx.strokeStyle = 'rgba(15, 23, 42, 0.75)';
    eCtx.lineWidth = 3;
    eCtx.strokeRect(48, tableTop, tableWidth, tableHeight);
    
    // Header column separator
    const headerHeight = 48;
    eCtx.beginPath();
    eCtx.moveTo(48, tableTop + headerHeight);
    eCtx.lineTo(1112, tableTop + headerHeight);
    eCtx.stroke();
    
    // Draw columns vertical dividers
    eCtx.beginPath();
    eCtx.moveTo(xQty, tableTop);
    eCtx.lineTo(xQty, tableTop + tableHeight);
    eCtx.moveTo(xPrice, tableTop);
    eCtx.lineTo(xPrice, tableTop + tableHeight);
    eCtx.moveTo(xAmount, tableTop);
    eCtx.lineTo(xAmount, tableTop + tableHeight);
    eCtx.stroke();
    
    // Column header labels text
    eCtx.font = 'bold 14px "Courier Prime", Courier, monospace';
    eCtx.textAlign = 'center';
    eCtx.fillText('PARTICULARS / DESCRIPTION', xDesc + colDescWidth / 2, tableTop + 30);
    eCtx.fillText('QTY', xQty + colQtyWidth / 2, tableTop + 30);
    eCtx.fillText('PRICE ($)', xPrice + colPriceWidth / 2, tableTop + 30);
    eCtx.fillText('AMOUNT ($)', xAmount + colAmountWidth / 2, tableTop + 30);
    
    // Row math coordinates
    const rowCount = 8;
    const rowHeight = (tableHeight - headerHeight) / rowCount; // 93px
    
    // Ruled horizontal lines for Particulars
    eCtx.strokeStyle = 'rgba(59, 130, 246, 0.15)'; // light blue ink lines
    eCtx.lineWidth = 2;
    for (let i = 1; i < rowCount; i++) {
      const y = tableTop + headerHeight + i * rowHeight;
      eCtx.beginPath();
      eCtx.moveTo(48, y);
      eCtx.lineTo(1112, y);
      eCtx.stroke();
    }
    
    // Draw table border overrides
    eCtx.strokeStyle = 'rgba(15, 23, 42, 0.5)';
    eCtx.lineWidth = 2;
    for (let i = 1; i < rowCount; i++) {
      const y = tableTop + headerHeight + i * rowHeight;
      // Draw horizontal dividing border across cols
      eCtx.beginPath();
      eCtx.moveTo(xQty, y);
      eCtx.lineTo(1112, y);
      eCtx.stroke();
    }
    
    // 4. Populate Row Values (Typed inputs & calculations)
    eCtx.textAlign = 'center';
    eCtx.textBaseline = 'middle';
    
    for (let i = 0; i < rowCount; i++) {
      const yCenter = tableTop + headerHeight + i * rowHeight + rowHeight / 2;
      
      const qtyInput = document.querySelector(`.qty-input[data-row="${i}"]`);
      const priceInput = document.querySelector(`.price-input[data-row="${i}"]`);
      const amountVal = document.querySelector(`.amount-val[data-row="${i}"]`);
      
      // Draw Quantity
      const qty = qtyInput ? qtyInput.value : '';
      if (qty && qty !== '0') {
        eCtx.font = 'bold 18px "Courier Prime", Courier, monospace';
        eCtx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        eCtx.fillText(qty, xQty + colQtyWidth / 2, yCenter);
      }
      
      // Draw Price
      const price = priceInput ? priceInput.value : '';
      if (price && parseFloat(price) > 0) {
        eCtx.font = 'bold 18px "Courier Prime", Courier, monospace';
        eCtx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        eCtx.fillText(parseFloat(price).toFixed(2), xPrice + colPriceWidth / 2, yCenter);
      }
      
      // Draw Calculated Amount (with blue stamped ink style)
      const amount = amountVal ? amountVal.textContent : '0.00';
      if (amount && parseFloat(amount) > 0) {
        eCtx.font = 'bold 18px "Courier Prime", Courier, monospace';
        eCtx.fillStyle = '#1d4ed8'; // Stamped Blue Ink
        eCtx.textAlign = 'right';
        eCtx.fillText(parseFloat(amount).toFixed(2), xAmount + colAmountWidth - 24, yCenter);
        eCtx.textAlign = 'center'; // reset
      }
      
      // Draw Row Handwriting Canvas
      const rowCanvasEl = rowCanvases[i];
      if (rowCanvasEl) {
        eCtx.drawImage(rowCanvasEl, xDesc, tableTop + headerHeight + i * rowHeight, colDescWidth, rowHeight);
      }
    }
    
    // 5. Draw Footer
    const footerTop = 1010;
    
    // Signature lines
    eCtx.strokeStyle = 'rgba(15, 23, 42, 0.75)';
    eCtx.lineWidth = 2;
    eCtx.beginPath();
    eCtx.moveTo(48, footerTop + 75);
    eCtx.lineTo(528, footerTop + 75);
    eCtx.stroke();
    
    eCtx.font = '14px "Courier Prime", Courier, monospace';
    eCtx.fillStyle = 'rgba(15, 23, 42, 0.7)';
    eCtx.textAlign = 'center';
    eCtx.textBaseline = 'alphabetic';
    eCtx.fillText('AUTHORIZED SIGNATURE', 288, footerTop + 95);
    
    // Draw Signature canvas ink overlay
    eCtx.drawImage(sigCanvas, 48, footerTop + 15, 480, 104);
    
    // Grand Total box
    eCtx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    eCtx.font = 'bold 15px "Courier Prime", Courier, monospace';
    eCtx.textAlign = 'right';
    eCtx.fillText('TOTAL AMOUNT ($)', 832, footerTop + 45);
    
    eCtx.strokeRect(852, footerTop + 15, 260, 76);
    
    // Print grand total value
    const grandTotal = document.getElementById('grand-total-val').textContent;
    eCtx.font = 'bold 24px "Courier Prime", Courier, monospace';
    eCtx.fillStyle = 'rgba(15, 23, 42, 0.95)';
    eCtx.textAlign = 'right';
    eCtx.fillText(grandTotal, 1112 - 24, footerTop + 55);
    
    // 6. Void stamp overlay
    if (status === 'Void') {
      eCtx.save();
      eCtx.translate(580, 620);
      eCtx.rotate(-20 * Math.PI / 180);
      
      eCtx.strokeStyle = '#dc2626';
      eCtx.lineWidth = 8;
      eCtx.strokeRect(-180, -50, 360, 100);
      
      eCtx.lineWidth = 2;
      eCtx.strokeRect(-172, -42, 344, 84);
      
      eCtx.font = 'bold 64px "Courier Prime", Courier, monospace';
      eCtx.fillStyle = '#dc2626';
      eCtx.textAlign = 'center';
      eCtx.textBaseline = 'middle';
      eCtx.fillText('VOID', 0, 5);
      eCtx.restore();
    }
    
    exportCanvas.toBlob((blob) => {
      resolve(blob);
    }, 'image/png');
  });
}

function formatVoucherID(seqNum) {
  return `#V-${String(seqNum).padStart(4, '0')}`;
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

// --- App Control Logic ---

function loadCurrentDate() {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  voucherDateInput.value = `${yyyy}-${mm}-${dd}`;
}

function updateNextVoucherID() {
  document.getElementById('next-voucher-id').textContent = formatVoucherID(nextSequenceNumber);
}

async function renderVoucherList(vouchers) {
  voucherList.innerHTML = '';
  updateResultCount(vouchers.length);

  if (vouchers.length === 0) {
    voucherList.appendChild(emptyHistory);
    return;
  }

  const urlMap = await getSignedImageUrls(vouchers.map(v => v.image_path));

  vouchers.forEach((v) => {
    const card = document.createElement('div');
    card.className = `voucher-card ${v.voucher_status === 'Void' ? 'voided' : ''}`;
    card.onclick = () => openVoucherDetail(v.id);

    const url = urlMap.get(v.image_path) || '';
    const displayId = formatVoucherID(v.sequence_number);
    const paymentClass = v.payment_method === 'Cash' ? '' : (v.payment_method === 'Transfer' ? 'transfer-method' : 'paynow-method');
    const status = getStatusBadgeInfo(v);

    card.innerHTML = `
      <div class="card-thumbnail">
        <img src="${url}" alt="Voucher ${displayId}">
        ${v.voucher_status === 'Void' ? '<span class="void-stamp-mini">VOID</span>' : ''}
      </div>
      <div class="card-details">
        <div class="card-row-top">
          <span class="card-id">${displayId}</span>
          <span class="card-date">${v.date}</span>
        </div>
        <span class="card-customer">${escapeHtml(v.customer_name)}</span>
        <div class="card-row-bottom">
          <span class="card-payment ${paymentClass}">${v.payment_method}</span>
          <span class="card-total">$${Number(v.total_amount).toFixed(2)}</span>
        </div>
        <div class="card-footer-row">
          <span class="status-pill sm ${status.className}">${status.label}</span>
          ${v.voucher_status !== 'Void' ? `<span class="status-pill sm ${v.settlement_status === 'Received' ? 'is-paid' : 'is-unpaid'}">${v.settlement_status === 'Received' ? 'Settled' : 'Unsettled'}</span>` : ''}
        </div>
      </div>
    `;

    voucherList.appendChild(card);
  });
}

function updateResultCount(count) {
  const n = count != null ? count : currentVouchers.length;
  resultCountEl.textContent = n === 1 ? '1 voucher' : `${n} vouchers`;
}

// Reflects one voucher's current state into the already-open detail modal --
// shared by openVoucherDetail and every action handler below so the modal
// never goes stale after mark-paid/unpaid/void/print.
function updateModalFromVoucher(voucher) {
  const displayId = formatVoucherID(voucher.sequence_number);
  modalVoucherId.textContent = displayId;
  modalVoucherDate.textContent = `Saved: ${formatTimestamp(voucher.created_at)}`;
  modalCustomerName.textContent = voucher.customer_phone
    ? `${voucher.customer_name} · ${voucher.customer_phone}`
    : voucher.customer_name;
  modalPaymentBadge.textContent = voucher.payment_method;
  modalPaymentBadge.className = `badge payment-badge ${
    voucher.payment_method === 'Cash' ? '' : (voucher.payment_method === 'Transfer' ? 'transfer-method' : 'paynow-method')
  }`;

  const isVoid = voucher.voucher_status === 'Void';
  const status = getStatusBadgeInfo(voucher);
  modalStatusBadge.textContent = status.label;
  modalStatusBadge.className = `status-pill ${status.className}`;

  detailModal.classList.toggle('voided', isVoid);
  voidBtn.style.display = isVoid ? 'none' : 'inline-flex';
  markPaidBtn.style.display = (!isVoid && voucher.payment_status === 'Unpaid') ? 'inline-flex' : 'none';
  markUnpaidBtn.style.display = (!isVoid && voucher.payment_status === 'Paid') ? 'inline-flex' : 'none';

  updateSettlementSectionFromVoucher(voucher, isVoid);
}

// Owner Settlement is internal-only and intentionally separate from the
// Paid/Unpaid block above -- it never reads payment_status, and (per
// supabase/schema.sql) is never baked into the printed voucher image. The
// status badge is shown to everyone (Staff included, read-only); the
// actions below it are hidden unless the logged-in user is Owner/Admin --
// the backend RPCs re-check this independently, so hiding here is only UX,
// not the actual security boundary.
function updateSettlementSectionFromVoucher(voucher, isVoid) {
  const isReceived = voucher.settlement_status === 'Received';
  modalSettlementBadge.textContent = isReceived ? 'Received' : 'Not Received';
  modalSettlementBadge.className = `status-pill ${isReceived ? 'is-paid' : 'is-unpaid'}`;

  if (isReceived) {
    const ownerName = (ownersById.get(voucher.settlement_received_by) || {}).name || 'an unknown owner';
    const recordedByName = (profilesById.get(voucher.settlement_recorded_by) || {}).name || 'unknown';
    modalSettlementDetail.textContent = `Received by ${ownerName} on ${formatTimestamp(voucher.settlement_at)} · recorded by ${recordedByName}`;
    modalSettlementDetail.hidden = false;
  } else {
    modalSettlementDetail.hidden = true;
  }

  const canManageSettlement = isOwnerAdmin() && !isVoid;
  modalSettlementActions.hidden = !canManageSettlement;
  if (canManageSettlement) {
    settlementReceiveRow.hidden = isReceived;
    markSettlementNotReceivedBtn.hidden = !isReceived;
    if (!isReceived) populateSettlementOwnerSelect();
  }
}

async function openVoucherDetail(voucherId) {
  const voucher = currentVouchers.find(v => v.id === voucherId);
  if (!voucher) return;

  activeVoucher = voucher;
  updateModalFromVoucher(voucher);
  modalVoucherImg.src = await getSignedImageUrl(voucher.image_path);
  detailModal.classList.add('active');
}

function closeVoucherDetail() {
  detailModal.classList.remove('active');
  activeVoucher = null;
}

// Reset form fields
function clearVoucherFields() {
  document.querySelectorAll('.qty-input').forEach(i => i.value = '');
  document.querySelectorAll('.price-input').forEach(i => i.value = '');
  document.querySelectorAll('.amount-val').forEach(a => {
    a.textContent = '';
    a.classList.add('is-zero');
  });
  const grandTotalEl = document.getElementById('grand-total-val');
  grandTotalEl.textContent = '';
  grandTotalEl.classList.add('is-zero');
  customerNameInput.value = '';
  customerPhoneInput.value = '';
  loadCurrentDate();
}

function clearAllCanvases() {
  allCanvases.forEach((canvasElement) => {
    const context = canvasCtxs.get(canvasElement);
    if (context) {
      context.clearRect(0, 0, canvasElement.width, canvasElement.height);
    }
    canvasStrokes.set(canvasElement, []);
  });
}

// Save Slip Handler
function setSaveButtonsLoading(loading) {
  [saveOnlyBtn, savePrintBtn].forEach((btn) => {
    btn.disabled = loading;
    btn.querySelector('.btn-spinner').hidden = !loading;
    const icon = btn.querySelector('.btn-icon');
    if (icon) icon.style.display = loading ? 'none' : '';
  });
}

async function handleSaveVoucher({ print = false } = {}) {
  if (isSaving) return; // belt-and-suspenders against a double-click slipping through

  const paymentMethodEl = document.querySelector('input[name="payment-method"]:checked');
  const paymentMethod = paymentMethodEl ? paymentMethodEl.value : 'Cash';

  // No longer a hard requirement -- a fast walk-in cash sale doesn't always
  // have a name to write down.
  const customerName = customerNameInput.value.trim() || 'Walk-in Customer';
  const customerPhone = customerPhoneInput.value.trim() || null;

  // Date picker gives yyyy-mm-dd, which is exactly what Postgres expects.
  // The dd/mm/yyyy form is only needed for the human-readable text baked
  // into the rendered PNG.
  const dateVal = voucherDateInput.value;
  let dateFormatted = '--/--/----';
  if (dateVal) {
    const parts = dateVal.split('-');
    dateFormatted = `${parts[2]}/${parts[1]}/${parts[0]}`;
  }

  // Items are recomputed and sanitized server-side in create_voucher; this
  // copy is only used to render the composite PNG.
  const items = [];
  for (let i = 0; i < 8; i++) {
    const qtyVal = parseFloat(document.querySelector(`.qty-input[data-row="${i}"]`).value) || 0;
    const priceVal = parseFloat(document.querySelector(`.price-input[data-row="${i}"]`).value) || 0;
    items.push({ rowIndex: i, qty: qtyVal, price: priceVal });
  }

  isSaving = true;
  setSaveButtonsLoading(true);
  paperVoucher.classList.add('rip-off');
  playTearSound();

  try {
    // Reserve the real number FIRST. Postgres sequences don't roll back, so
    // a number can't be safely guessed client-side in advance (a previously
    // failed save can leave a gap) -- the printed PNG has to be rendered
    // with the number the database actually confirms, not a guess.
    const { data: reservedSeqNum, error: reserveError } = await supabaseClient.rpc('reserve_voucher_sequence_number');
    if (reserveError) throw reserveError;

    const compositeBlob = await renderCompositeVoucher(
      reservedSeqNum,
      dateFormatted,
      paymentMethod,
      'Active',
      customerName,
      customerPhone,
      rowCanvases,
      sigCanvas
    );

    const imagePath = `${crypto.randomUUID()}.png`;
    const { error: uploadError } = await supabaseClient.storage
      .from('voucher-images')
      .upload(imagePath, compositeBlob, { contentType: 'image/png' });
    if (uploadError) throw uploadError;

    const drawingData = buildDrawingData();

    const { data: newVoucher, error: createError } = await supabaseClient.rpc('create_voucher', {
      p_customer_name: customerName,
      p_customer_phone: customerPhone,
      p_date: dateVal,
      p_payment_method: paymentMethod,
      p_items: items,
      p_drawing_data: drawingData,
      p_image_path: imagePath,
      p_sequence_number: reservedSeqNum,
    });
    if (createError) throw createError;

    // Payment Method and Payment Status are independent -- create_voucher
    // only derives a default status from the method (patch_003), so a
    // manually-chosen status that disagrees with that default needs a
    // follow-up correction call using the same RPCs the ledger's Mark
    // Paid/Unpaid buttons already use.
    let finalVoucher = newVoucher;
    const paymentStatusEl = document.querySelector('input[name="payment-status"]:checked');
    const paymentStatus = paymentStatusEl ? paymentStatusEl.value : 'Unpaid';
    if (paymentStatus !== newVoucher.payment_status) {
      const correctionRpc = paymentStatus === 'Paid' ? 'mark_voucher_paid' : 'mark_voucher_unpaid';
      const { data: corrected, error: statusError } = await supabaseClient.rpc(correctionRpc, { p_voucher_id: newVoucher.id });
      if (statusError) {
        // The voucher itself already saved successfully -- only the status
        // correction failed, so don't treat this as a full save failure.
        console.error('Error correcting payment status:', statusError);
        showToast(`Voucher saved, but setting status to ${paymentStatus} failed -- fix it from the ledger.`, 'error');
      } else {
        finalVoucher = corrected;
      }
    }

    const displayId = formatVoucherID(finalVoucher.sequence_number);

    currentVouchers.unshift(finalVoucher);
    nextSequenceNumber = finalVoucher.sequence_number + 1;
    if (matchesCurrentFilters(finalVoucher)) {
      renderVoucherList(currentVouchers);
    } else {
      updateResultCount();
    }

    if (print) {
      await printVoucher(finalVoucher);
      showToast(`Voucher ${displayId} saved and sent to print.`, 'success');
    } else {
      showToast(`Voucher ${displayId} saved.`, 'success');
    }

    setTimeout(() => {
      clearAllCanvases();
      clearVoucherFields();
      updateNextVoucherID();

      paperVoucher.classList.remove('rip-off');
      paperVoucher.classList.add('slide-in');

      setTimeout(() => {
        paperVoucher.classList.remove('slide-in');
      }, 600);

    }, 700);

  } catch (error) {
    console.error('Failed to save voucher:', error);
    showToast('Failed to save: ' + describeRpcError(error), 'error');
    paperVoucher.classList.remove('rip-off');
  } finally {
    isSaving = false;
    setSaveButtonsLoading(false);
  }
}

// Modal actions are mutually exclusive (you wouldn't click two at once), so
// one shared loading flag covers all of them -- disables the row while an
// RPC is in flight to stop a double-tap firing it twice.
function setModalActionsLoading(loading) {
  [markPaidBtn, markUnpaidBtn, voidBtn, printBtn, downloadBtn, markSettlementReceivedBtn, markSettlementNotReceivedBtn].forEach((btn) => {
    btn.disabled = loading;
  });
}

async function handleVoidActiveVoucher() {
  if (!activeVoucher) return;
  const displayId = formatVoucherID(activeVoucher.sequence_number);
  const ok = await showConfirm(`Are you sure you want to VOID voucher ${displayId}?\nThis cannot be undone.`, { confirmLabel: 'Void Voucher', danger: true });
  if (!ok) return;

  setModalActionsLoading(true);
  const { data: updated, error } = await supabaseClient.rpc('void_voucher', { p_voucher_id: activeVoucher.id });
  setModalActionsLoading(false);
  if (error) {
    console.error('Error voiding voucher:', error);
    showToast('Failed to void voucher: ' + describeRpcError(error), 'error');
    return;
  }

  activeVoucher = updated;
  patchVoucherInLocalState(updated);
  updateModalFromVoucher(updated);
  showToast(`Voucher ${displayId} voided.`, 'success');
}

async function handleMarkPaid() {
  if (!activeVoucher) return;
  setModalActionsLoading(true);
  const { data: updated, error } = await supabaseClient.rpc('mark_voucher_paid', { p_voucher_id: activeVoucher.id });
  setModalActionsLoading(false);
  if (error) {
    console.error('Error marking voucher paid:', error);
    showToast('Failed to mark paid: ' + describeRpcError(error), 'error');
    return;
  }
  activeVoucher = updated;
  patchVoucherInLocalState(updated);
  updateModalFromVoucher(updated);
  showToast(`Voucher ${formatVoucherID(updated.sequence_number)} marked Paid.`, 'success');
}

async function handleMarkUnpaid() {
  if (!activeVoucher) return;
  setModalActionsLoading(true);
  const { data: updated, error } = await supabaseClient.rpc('mark_voucher_unpaid', { p_voucher_id: activeVoucher.id });
  setModalActionsLoading(false);
  if (error) {
    console.error('Error marking voucher unpaid:', error);
    showToast('Failed to mark unpaid: ' + describeRpcError(error), 'error');
    return;
  }
  activeVoucher = updated;
  patchVoucherInLocalState(updated);
  updateModalFromVoucher(updated);
  showToast(`Voucher ${formatVoucherID(updated.sequence_number)} marked Unpaid.`, 'success');
}

async function handleMarkSettlementReceived() {
  if (!activeVoucher) return;
  const ownerId = settlementOwnerSelect.value;
  if (!ownerId) {
    showToast('Select an owner first.', 'error');
    return;
  }
  setModalActionsLoading(true);
  const { data: updated, error } = await supabaseClient.rpc('mark_voucher_settlement_received', {
    p_voucher_id: activeVoucher.id,
    p_owner_id: ownerId,
  });
  setModalActionsLoading(false);
  if (error) {
    console.error('Error marking settlement received:', error);
    showToast('Failed to update Owner Settlement: ' + describeRpcError(error), 'error');
    return;
  }
  activeVoucher = updated;
  patchVoucherInLocalState(updated);
  updateModalFromVoucher(updated);
  showToast(`Voucher ${formatVoucherID(updated.sequence_number)} marked Owner Received.`, 'success');
}

async function handleMarkSettlementNotReceived() {
  if (!activeVoucher) return;
  setModalActionsLoading(true);
  const { data: updated, error } = await supabaseClient.rpc('mark_voucher_settlement_not_received', {
    p_voucher_id: activeVoucher.id,
  });
  setModalActionsLoading(false);
  if (error) {
    console.error('Error marking settlement not received:', error);
    showToast('Failed to update Owner Settlement: ' + describeRpcError(error), 'error');
    return;
  }
  activeVoucher = updated;
  patchVoucherInLocalState(updated);
  updateModalFromVoucher(updated);
  showToast(`Voucher ${formatVoucherID(updated.sequence_number)} reverted to Settlement Not Received.`, 'success');
}

// Shared by the modal's Print button and the Save & Print workflow -- logs
// the print event (audit trail) and triggers the browser print dialog
// against the voucher's image. Returns the updated voucher.
// A dedicated print page rather than just opening the raw stored image --
// gives it proper page margins and centers it like an actual document
// instead of however the browser happens to render a bare image.
// Payment/void status can change after the voucher's PNG was rendered
// (mark paid/unpaid, void) -- the saved image itself is never regenerated,
// so the status shown on a printout must come from an overlay reflecting
// the voucher's CURRENT row, the same way the on-screen modal's status
// pill already does via getStatusBadgeInfo(). Void and Paid/Unpaid are
// mutually exclusive here (matching that function's behavior everywhere
// else in the app) so a voided voucher always shows VOID alone, never a
// competing payment badge.
function buildPrintHtml(imageUrl, voucher) {
  const displayId = formatVoucherID(voucher.sequence_number);
  const printedAt = new Date().toLocaleString();
  const status = getStatusBadgeInfo(voucher);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${displayId}</title>
<style>
  @page { size: auto; margin: 14mm; }
  html, body {
    margin: 0;
    padding: 0;
    background: #ffffff;
    font-family: 'Courier New', Courier, monospace;
  }
  .print-page {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .print-img-wrap {
    position: relative;
    width: 100%;
    max-width: 760px;
  }
  img {
    display: block;
    width: 100%;
    height: auto;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .print-footer {
    margin-top: 8px;
    font-size: 9px;
    color: #888;
    text-align: center;
  }
  /* Anchored near the Total Amount box (drawn at roughly 73-96% of the
     image width, 83-89% of its height) -- see renderCompositeVoucher(). */
  .print-status-badge {
    position: absolute;
    font-family: 'Courier New', Courier, monospace;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    pointer-events: none;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .print-status-badge.is-void {
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%) rotate(-20deg);
    border: 4px double #dc2626;
    color: #dc2626;
    font-size: 2.4rem;
    padding: 6px 26px;
    border-radius: 4px;
    background-color: rgba(254, 249, 195, 0.92);
  }
  /* Paid: a confirmation stamp -- rotated, double-bordered, ink-on-paper
     look, like a real rubber "PAID" stamp. */
  .print-status-badge.is-paid {
    top: 78%;
    right: 5%;
    transform: rotate(-10deg);
    border: 3px double #059669;
    color: #059669;
    font-size: 1.15rem;
    padding: 4px 16px;
    border-radius: 4px;
    background-color: rgba(255, 255, 255, 0.6);
  }
  /* Unpaid: an outstanding/due indicator, not a stamp -- flat, filled,
     unrotated, so it reads as an alert rather than a certification. */
  .print-status-badge.is-unpaid {
    top: 78%;
    right: 5%;
    border: 2px solid #b45309;
    color: #ffffff;
    background-color: #d97706;
    font-size: 1rem;
    padding: 4px 14px;
    border-radius: 4px;
  }
</style>
</head>
<body>
  <div class="print-page">
    <div class="print-img-wrap">
      <img src="${imageUrl}" alt="Voucher ${displayId}">
      <div class="print-status-badge ${status.className}">${status.label}</div>
    </div>
    <div class="print-footer">Printed ${printedAt}</div>
  </div>
</body>
</html>`;
}

async function printVoucher(voucher) {
  const { data: updated, error } = await supabaseClient.rpc('log_voucher_print', { p_voucher_id: voucher.id });
  if (error) {
    console.error('Error logging print:', error);
    showToast('Failed to print: ' + describeRpcError(error), 'error');
    return voucher;
  }

  patchVoucherInLocalState(updated);

  const url = await getSignedImageUrl(updated.image_path);
  const printWindow = window.open('', '_blank');
  if (printWindow) {
    printWindow.document.write(buildPrintHtml(url, updated));
    printWindow.document.close();
    printWindow.onload = () => printWindow.print();
  } else {
    showToast('Could not open the print window -- check your browser\'s pop-up blocker.', 'error');
  }
  return updated;
}

async function handlePrintActiveVoucher() {
  if (!activeVoucher) return;
  setModalActionsLoading(true);
  activeVoucher = await printVoucher(activeVoucher);
  setModalActionsLoading(false);
  updateModalFromVoucher(activeVoucher);
}

async function handleDownloadActiveVoucher() {
  if (!activeVoucher) return;

  setModalActionsLoading(true);
  try {
    // Re-fetch as a blob rather than linking straight to the signed URL --
    // the `download` attribute is ignored for cross-origin links, so without
    // this the browser would just navigate to the image instead of saving it.
    const signedUrl = await getSignedImageUrl(activeVoucher.image_path);
    const response = await fetch(signedUrl);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `InkVoucher_${formatVoucherID(activeVoucher.sequence_number)}.png`;
    link.style.display = 'none';
    document.body.appendChild(link);

    // dispatchEvent is more reliable than .click() in sandboxed/localhost environments
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } catch (err) {
    console.error('Download failed:', err);
    showToast('Download failed. Try right-clicking the voucher image and selecting "Save image as".', 'error');
  } finally {
    setModalActionsLoading(false);
  }
}

let searchDebounceTimer = null;
function handleSearch(e) {
  const value = e.target.value;
  searchClearBtn.hidden = value.length === 0;
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    currentSearchQuery = value.toLowerCase().trim();
    reloadVouchers();
  }, 300);
}

function handleClearSearch() {
  searchInput.value = '';
  searchClearBtn.hidden = true;
  currentSearchQuery = '';
  reloadVouchers();
}

function handleFilterChipClick(e) {
  const chip = e.target.closest('.filter-chip');
  if (!chip) return;
  filterChipRow.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  currentStatusFilter = chip.dataset.filter;
  reloadVouchers();
}

// Ledger History's own date filter -- independent of the Dashboard's, but
// shares getDateRangeForPreset() for identical Today/Yesterday/Week/Month
// math. The select's own displayed value is the "currently active filter"
// indicator; the clear button is only shown once a filter is applied.
function handleLedgerDateFilterChange() {
  const preset = ledgerDateFilter.value;

  if (preset === 'all') {
    ledgerDateCustomRow.hidden = true;
    ledgerDateClearBtn.hidden = true;
    currentDateRange = null;
    reloadVouchers();
    return;
  }

  ledgerDateClearBtn.hidden = false;

  if (preset === 'custom') {
    ledgerDateCustomRow.hidden = false;
    return; // wait for the Apply button rather than reloading on every keystroke
  }

  ledgerDateCustomRow.hidden = true;
  currentDateRange = getDateRangeForPreset(preset);
  reloadVouchers();
}

function handleLedgerDateClear() {
  ledgerDateFilter.value = 'all';
  ledgerDateCustomRow.hidden = true;
  ledgerDateClearBtn.hidden = true;
  currentDateRange = null;
  reloadVouchers();
}

function handleLedgerDateApply() {
  if (!ledgerDateFrom.value || !ledgerDateTo.value) return;
  currentDateRange = { from: ledgerDateFrom.value, to: ledgerDateTo.value };
  reloadVouchers();
}

function handleLedgerSettlementFilterChange() {
  currentSettlementFilter = ledgerSettlementFilter.value;
  reloadVouchers();
}

function handleLedgerOwnerFilterChange() {
  currentOwnerFilter = ledgerOwnerFilter.value;
  reloadVouchers();
}

function handleLedgerStaffFilterChange() {
  currentStaffFilter = ledgerStaffFilter.value;
  reloadVouchers();
}

// --- Listeners & Tool configuration ---

// Active tool toggles (Pencil vs Eraser)
document.querySelectorAll('input[name="active-tool"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    activeTool = e.target.value;
    
    if (activeTool === 'eraser') {
      colorPickerGroup.classList.add('disabled');
      colorDivider.classList.add('disabled');
    } else {
      colorPickerGroup.classList.remove('disabled');
      colorDivider.classList.remove('disabled');
    }
    
    updateAllCanvasSettings();
  });
});

// Color options
colorButtons.forEach((btn) => {
  btn.addEventListener('click', (e) => {
    colorButtons.forEach((b) => b.classList.remove('active'));
    e.target.classList.add('active');
    penColor = e.target.dataset.color;
    
    // Auto toggle back to pencil if in eraser mode
    const pencilRadio = document.querySelector('input[name="active-tool"][value="pencil"]');
    if (pencilRadio && activeTool === 'eraser') {
      pencilRadio.checked = true;
      activeTool = 'pencil';
      colorPickerGroup.classList.remove('disabled');
      colorDivider.classList.remove('disabled');
    }
    
    updateAllCanvasSettings();
  });
});

// Slider updates
brushSizeSlider.addEventListener('input', (e) => {
  penWidth = parseFloat(e.target.value);
  brushSizeVal.textContent = `${penWidth.toFixed(1)}px`;
  updateAllCanvasSettings();
});

// Scale voucher element to fit inside the paper viewport dynamically
function scaleVoucherToFit() {
  // Hard lock, independent of whichever event path called this -- the
  // voucher's transform must never change mid-stroke. Whoever called us
  // gets the rescale once the stroke ends instead (see stopDrawing()).
  if (isDrawingActive) {
    pendingRescale = true;
    return;
  }

  const viewport = document.querySelector('.paper-viewport');
  const voucher = document.getElementById('paper-voucher');
  const header = document.querySelector('.workspace-header');
  const footer = document.querySelector('.workspace-footer');
  const toolsBar = document.querySelector('.canvas-tools-bar');
  const section = document.querySelector('.canvas-section');
  if (!viewport || !voucher || !header || !footer || !toolsBar || !section) return;

  const sectionStyle = getComputedStyle(section);
  const sectionPaddingY = parseFloat(sectionStyle.paddingTop) + parseFloat(sectionStyle.paddingBottom);
  const toolsBarMarginBottom = parseFloat(getComputedStyle(toolsBar).marginBottom) || 0;

  // Explicitly reserve space for the header, footer, and toolbar before
  // deciding how big the voucher can be -- measuring window.innerHeight
  // directly rather than only trusting the flex cascade. On iOS Safari the
  // real visible height shrinks while the chrome (tab bar/toolbar) is
  // showing, so the footer needs a hard guarantee of its own space rather
  // than just whatever's left over. header/footer's own padding already
  // includes env(safe-area-inset-top)/env(safe-area-inset-bottom) (see
  // index.css), so reserving their offsetHeight here already accounts for
  // the safe area too -- no separate safe-area term needed.
  //
  // Deliberately window.innerHeight, NOT visualViewport.height:
  // visualViewport fires far more readily than window.innerHeight during
  // ordinary touch/Pencil interaction, and using it as the height source
  // here previously made the voucher visibly zoom while writing. The
  // visualViewport listener below still WAKES UP this calculation (for
  // toolbar changes that don't fire a plain 'resize'), it just doesn't
  // feed it a different, noisier height value.
  const reservedHeight = header.offsetHeight + footer.offsetHeight + toolsBar.offsetHeight + toolsBarMarginBottom + sectionPaddingY;
  const availableHeight = window.innerHeight - reservedHeight - 16;
  const availableWidth = viewport.clientWidth - 32;

  // The voucher's real, unscaled size read directly from the element
  // (transform doesn't affect offsetWidth/offsetHeight) instead of
  // hardcoding its CSS dimensions as separate constants. Inert with
  // respect to timing/zoom -- it's a static read, not a new recalculation
  // trigger -- it just keeps the aspect ratio honest if .paper-voucher's
  // CSS size ever changes.
  const voucherWidth = voucher.offsetWidth;
  const voucherHeight = voucher.offsetHeight;
  if (!voucherWidth || !voucherHeight) return; // not laid out yet (e.g. before first paint)

  const scaleX = availableWidth / voucherWidth;
  const scaleY = availableHeight / voucherHeight;
  // Allow growing past natural size so the voucher fills the screen on
  // tablets/desktops with room to spare, capped so it doesn't look oversized
  // on a large monitor. Floored so a transient layout glitch can't shrink
  // it to nothing.
  const scale = Math.max(Math.min(scaleX, scaleY, 1.4), 0.3);

  voucher.style.transform = `scale(${scale})`;
}

// Window resize handler combining layout and canvas updates.
// On iOS Safari, the chrome bar collapsing/expanding during a touch
// interaction also fires 'resize' -- running the full rescale mid-stroke
// would wipe/redraw every canvas and visibly disrupt the line being drawn.
//
// Handwriting lifts the pencil between every letter, so isDrawingActive
// alone goes false for brief instants throughout an entire writing
// session -- a resize landing in exactly one of those gaps could still
// rescale the voucher mid-sentence. RESCALE_QUIET_MS makes it also wait
// for a real pause (longer than a letter-to-letter gap) since the last
// stroke ended before committing to a rescale.
let resizeDebounceTimer = null;
const RESCALE_QUIET_MS = 600;
function handleResize() {
  clearTimeout(resizeDebounceTimer);
  resizeDebounceTimer = setTimeout(() => {
    if (appContainer.hidden) return; // not logged in yet -- canvases are zero-size behind the auth screen
    if (isDrawingActive || Date.now() - lastStrokeEndTime < RESCALE_QUIET_MS) {
      handleResize();
      return;
    }
    syncSidebarForViewport();
    scaleVoucherToFit();
    resizeAndScaleCanvases();
  }, 350);
}
window.addEventListener('resize', handleResize);
window.addEventListener('orientationchange', handleResize);
// iOS Safari's dynamic toolbar show/hide sometimes only changes
// visualViewport.height, without firing a plain window 'resize' -- route it
// through the same debounced/locked path rather than leaving it unhandled.
// This only WAKES UP the debounce above; scaleVoucherToFit() still reads
// window.innerHeight, never visualViewport.height -- see the note there.
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', handleResize);
}

// Global actions
clearDrawingsBtn.addEventListener('click', async () => {
  const ok = await showConfirm('Clear all handwritten descriptions and signatures?', { confirmLabel: 'Clear', danger: true });
  if (ok) clearAllCanvases();
});

clearAllBtn.addEventListener('click', async () => {
  const ok = await showConfirm('Clear handwriting and reset all numeric quantities and pricing?', { confirmLabel: 'Clear', danger: true });
  if (ok) {
    clearAllCanvases();
    clearVoucherFields();
  }
});

saveOnlyBtn.addEventListener('click', () => handleSaveVoucher({ print: false }));
savePrintBtn.addEventListener('click', () => handleSaveVoucher({ print: true }));
searchInput.addEventListener('input', handleSearch);
searchClearBtn.addEventListener('click', handleClearSearch);
filterChipRow.addEventListener('click', handleFilterChipClick);
ledgerDateFilter.addEventListener('change', handleLedgerDateFilterChange);
ledgerDateClearBtn.addEventListener('click', handleLedgerDateClear);
ledgerDateApplyBtn.addEventListener('click', handleLedgerDateApply);
ledgerSettlementFilter.addEventListener('change', handleLedgerSettlementFilterChange);
ledgerOwnerFilter.addEventListener('change', handleLedgerOwnerFilterChange);
ledgerStaffFilter.addEventListener('change', handleLedgerStaffFilterChange);
// Sane starting point for the custom-range inputs, same reasoning as the
// Dashboard's equivalent fields.
ledgerDateFrom.value = toLocalISODate(new Date());
ledgerDateTo.value = toLocalISODate(new Date());

// Modal details actions
closeModalBtn.addEventListener('click', closeVoucherDetail);
voidBtn.addEventListener('click', handleVoidActiveVoucher);
downloadBtn.addEventListener('click', handleDownloadActiveVoucher);
markPaidBtn.addEventListener('click', handleMarkPaid);
markUnpaidBtn.addEventListener('click', handleMarkUnpaid);
printBtn.addEventListener('click', handlePrintActiveVoucher);

// Dashboard
openDashboardBtn.addEventListener('click', openDashboard);
closeDashboardBtn.addEventListener('click', closeDashboard);
dashboardRangeControl.addEventListener('change', (e) => {
  if (e.target.name !== 'dashboard-range') return;
  const isCustom = e.target.value === 'custom';
  dashboardCustomRange.hidden = !isCustom;
  if (!isCustom) loadDashboard();
});
dashboardCustomApplyBtn.addEventListener('click', loadDashboard);
dashboardOutstandingList.addEventListener('click', (e) => {
  const row = e.target.closest('.dashboard-outstanding-row');
  if (!row) return;
  jumpToCustomerLedger(row.dataset.name, row.dataset.phone);
});

// Sidebar toggles
hideSidebarBtn.addEventListener('click', () => {
  sidebar.classList.add('collapsed');
  showSidebarBtn.style.display = 'inline-flex';
});

showSidebarBtn.addEventListener('click', () => {
  sidebar.classList.remove('collapsed');
  showSidebarBtn.style.display = 'none';
});

// Below this width the sidebar becomes an absolutely-positioned overlay (see
// index.css) instead of a flex sibling, so it must start collapsed or it
// covers the workspace underneath it. Only re-applied when crossing the
// breakpoint, so it doesn't fight a manual toggle made within the same regime.
const SIDEBAR_BREAKPOINT = 900;
let sidebarWasNarrow = null;
function syncSidebarForViewport() {
  const isNarrow = window.innerWidth <= SIDEBAR_BREAKPOINT;
  if (isNarrow === sidebarWasNarrow) return;
  sidebarWasNarrow = isNarrow;
  sidebar.classList.toggle('collapsed', isNarrow);
  showSidebarBtn.style.display = isNarrow ? 'inline-flex' : 'none';
}

// Initializer
async function startApp() {
  try {
    const [company] = await Promise.all([
      loadCompanySettings(),
      loadCurrentUserProfile(),
      loadOwners(),
      loadProfiles(),
    ]);
    companySettings = company;

    openOwnerMgmtBtn.hidden = !isOwnerAdmin();
    populateOwnerFilterSelect();
    populateStaffFilterSelect();

    await reloadVouchers();

    const maxSeqNum = currentVouchers.reduce((max, v) => Math.max(max, v.sequence_number), 0);
    nextSequenceNumber = maxSeqNum + 1;

    updateNextVoucherID();
    loadCurrentDate();
    setupCanvasListeners();
    syncSidebarForViewport();

    // Safety delay to ensure browser layout is resolved
    setTimeout(() => {
      scaleVoucherToFit();
      resizeAndScaleCanvases();
    }, 50);

    setupCalculationEngine();

  } catch (error) {
    console.error('Failed to start InkVoucher application:', error);
  }
}

// Ensure resizing recalculates after page resources finish loading.
// Guarded because this fires unconditionally on window 'load', which can
// happen before login -- the canvases are display:none (zero size) behind
// the auth screen at that point, and resizing a zero-size canvas throws.
window.addEventListener('load', () => {
  if (appContainer.hidden) return;
  scaleVoucherToFit();
  resizeAndScaleCanvases();
});

// --- Authentication Gate ---
let appStarted = false;

function showAuthScreen() {
  authOverlay.hidden = false;
  appContainer.hidden = true;
}

async function enterApp() {
  authOverlay.hidden = true;
  appContainer.hidden = false;
  if (!appStarted) {
    appStarted = true;
    await startApp();
  }
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authErrorEl.style.display = 'none';
  loginBtn.disabled = true;

  const { error } = await supabaseClient.auth.signInWithPassword({
    email: loginEmailInput.value.trim(),
    password: loginPasswordInput.value,
  });

  loginBtn.disabled = false;
  if (error) {
    authErrorEl.textContent = error.message;
    authErrorEl.style.display = 'block';
  }
  // On success, onAuthStateChange below shows the app.
});

logoutBtn.addEventListener('click', () => {
  supabaseClient.auth.signOut();
});

supabaseClient.auth.onAuthStateChange((event, session) => {
  if (session) {
    enterApp();
  } else if (appStarted) {
    // Full reset on logout rather than manually unwinding in-memory state.
    location.reload();
  } else {
    showAuthScreen();
  }
});

supabaseClient.auth.getSession().then(({ data: { session } }) => {
  if (session) {
    enterApp();
  } else {
    showAuthScreen();
  }
});
