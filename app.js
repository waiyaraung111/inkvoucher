/* ==========================================================================
   InkVoucher - Javascript Engine
   ========================================================================== */

// --- Build/version indicator: Environment field ---
// data-app-env on .build-env-value is either an explicit label baked in at
// build time (APP_ENV set when `npm run build`/`npm run deploy` ran -- see
// build.js) or the literal string "auto" (the committed default, meaning
// no override was set). "auto" falls back to detecting it from the actual
// hostname the page loaded from -- this is what makes Development work
// with zero configuration for local testing, and what lets a future
// staging/testing deployment be recognized automatically too, as long as
// its hostname/Worker name contains "staging" or "test" -- no changes to
// this file or build.js needed for that case. Runs immediately (not
// gated behind login) since these elements exist in the DOM regardless of
// auth state.
function detectEnvironmentFromHostname() {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return 'Development';
  if (/(?:^|[.-])(?:staging|test|testing)(?:[.-]|$)/i.test(host)) return 'Testing';
  return 'Production';
}

document.querySelectorAll('.build-env-value').forEach((el) => {
  const explicit = el.dataset.appEnv;
  el.textContent = explicit && explicit !== 'auto' ? explicit : detectEnvironmentFromHostname();
});

// --- Constants & State ---
let currentVouchers = [];
let activeVoucher = null;
let nextSequenceNumber = 1;
let currentSearchQuery = '';
// Live, APPLIED ledger filter state -- only ever changed by applyLedgerFilters()
// (or jumpToCustomerLedger()'s direct customer-drilldown), never by the
// Filters modal's controls directly. This is what reloadVouchers()/
// matchesCurrentFilters() actually read.
let currentStatusFilter = 'all'; // all | active | paid | unpaid | void
let currentDatePreset = 'all'; // all | today | yesterday | week | month | custom -- tracked separately from currentDateRange purely so active-filter chips can show "Today" instead of a raw date range
let currentDateRange = null; // null = All Dates, else {from, to} yyyy-mm-dd -- Ledger History's own date filter, independent of the Dashboard's
let currentSettlementFilter = ''; // '' = All, else 'Not Received' | 'Received'
let currentOwnerFilter = ''; // '' = All Owners, else an owners.id
let currentStaffFilter = ''; // '' = All Staff, else a staff_members.id (the actual person, not the login -- see made_by_staff_id)

// DRAFT ledger filter state -- what the Filters modal's controls actually
// read/write while it's open. Seeded from the live state above when the
// modal opens, and only copied back into the live state by Apply -- so
// adjusting several filters doesn't reload the ledger after every click,
// only once. Clear All resets this (and the modal's controls) without
// closing the modal or touching the live state until Apply is pressed.
let filtersDraft = {
  status: 'all',
  datePreset: 'all',
  dateRange: null,
  staffId: '',
  settlementStatus: '',
  ownerId: '',
};

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

// Staff Members (Staff Management) -- the actual person who made a voucher,
// distinct from profiles/auth.users above (which is the, possibly shared,
// login). Same cache/refresh pattern as owners.
let allStaffMembers = [];
let staffMembersById = new Map();
let editingStaffId = null;

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
const setAllHandwritingBtn = document.getElementById('set-all-handwriting-btn');
const setAllTypingBtn = document.getElementById('set-all-typing-btn');
const colorButtons = document.querySelectorAll('.color-btn');
const toolRadios = document.querySelectorAll('input[name="active-tool"]');
const colorPickerGroup = document.getElementById('color-picker-group');
const colorDivider = document.getElementById('color-divider');
const voucherDateInput = document.getElementById('voucher-date');
const voucherList = document.getElementById('voucher-list');
const emptyHistory = document.getElementById('empty-history');
const searchInput = document.getElementById('search-input');
const searchClearBtn = document.getElementById('search-clear-btn');
const resultCountEl = document.getElementById('result-count');

// Ledger Filters -- sidebar entry point (always visible)
const openLedgerFiltersBtn = document.getElementById('open-ledger-filters-btn');
const filtersBadge = document.getElementById('filters-badge');
const activeFilterChipsEl = document.getElementById('active-filter-chips');

// Ledger Filters modal -- all controls operate on a draft copy of the live
// filter state (see filtersDraft below) and only take effect on Apply.
const ledgerFiltersModal = document.getElementById('ledger-filters-modal');
const closeLedgerFiltersBtn = document.getElementById('close-ledger-filters-btn');
const filtersStatusChipRow = document.getElementById('filters-status-chip-row');
const filtersDateSegmented = document.getElementById('filters-date-segmented');
const filtersDateCustomRow = document.getElementById('filters-date-custom-row');
const filtersDateFrom = document.getElementById('filters-date-from');
const filtersDateTo = document.getElementById('filters-date-to');
const filtersStaffSelect = document.getElementById('filters-staff-select');
const filtersSettlementSelect = document.getElementById('filters-settlement-select');
const filtersOwnerSelect = document.getElementById('filters-owner-select');
const filtersClearAllBtn = document.getElementById('filters-clear-all-btn');
const filtersApplyBtn = document.getElementById('filters-apply-btn');

const customerNameInput = document.getElementById('customer-name-input');
const customerPhoneInput = document.getElementById('customer-phone-input');
const madeByStaffSelect = document.getElementById('made-by-staff-select');
const saveOnlyBtn = document.getElementById('save-only-btn');
const savePrintBtn = document.getElementById('save-print-btn');

// Save & Print choice modal
const savePrintChoiceModal = document.getElementById('save-print-choice-modal');
const closeSavePrintChoiceBtn = document.getElementById('close-save-print-choice-btn');
const choicePrintA5Btn = document.getElementById('choice-print-a5-btn');
const choicePrintReceiptBtn = document.getElementById('choice-print-receipt-btn');
const choiceSaveOnlyBtn = document.getElementById('choice-save-only-btn');
const choiceCancelBtn = document.getElementById('choice-cancel-btn');

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
const modalMadeBy = document.getElementById('modal-made-by');
const modalPaymentBadge = document.getElementById('modal-payment-badge');
const modalStatusBadge = document.getElementById('modal-status-badge');
const modalVoucherImg = document.getElementById('modal-voucher-img');
const modalVoidOverlay = document.getElementById('modal-void-overlay');
const expandPreviewBtn = document.getElementById('expand-preview-btn');
const voidBtn = document.getElementById('void-btn');
const downloadBtn = document.getElementById('download-btn');
const markPaidBtn = document.getElementById('mark-paid-btn');
const markUnpaidBtn = document.getElementById('mark-unpaid-btn');
const printBtn = document.getElementById('print-btn');
const printThermalBtn = document.getElementById('print-thermal-btn');

// Full-Screen Voucher Preview Lightbox -- customer-facing image only, never
// Owner Settlement/internal controls (those stay in the detail modal above)
// and never part of print/PDF output.
const voucherLightbox = document.getElementById('voucher-lightbox');
const lightboxImg = document.getElementById('lightbox-voucher-img');
const lightboxTitle = document.getElementById('lightbox-voucher-id');
const closeLightboxBtn = document.getElementById('close-lightbox-btn');
const lightboxZoomInBtn = document.getElementById('lightbox-zoom-in-btn');
const lightboxZoomOutBtn = document.getElementById('lightbox-zoom-out-btn');
const lightboxZoomFitBtn = document.getElementById('lightbox-zoom-fit-btn');
const lightboxBody = document.getElementById('lightbox-body');

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

// Staff Management Elements
const openStaffMgmtBtn = document.getElementById('open-staff-mgmt-btn');
const staffMgmtModal = document.getElementById('staff-mgmt-modal');
const closeStaffMgmtBtn = document.getElementById('close-staff-mgmt-btn');
const staffAddForm = document.getElementById('staff-add-form');
const staffAddNameInput = document.getElementById('staff-add-name-input');
const staffListEl = document.getElementById('staff-list');
const staffListLoading = document.getElementById('staff-list-loading');

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

// Login directory (profiles) -- used only to resolve a settlement's
// "recorded by" id into a display name now (the Ledger's Staff Name filter
// and the voucher's Made By are driven by staff_members below instead,
// since several staff can share one login).
async function loadProfiles() {
  const { data, error } = await supabaseClient.from('profiles').select('id, name, role').order('name');
  if (error) {
    console.error('Failed to load staff list:', error);
    return;
  }
  allProfiles = data || [];
  profilesById = new Map(allProfiles.map((p) => [p.id, p]));
}

// Staff Members (Staff Management) -- the actual person who made a
// voucher. Loaded in full (active + disabled) so the Staff Management list
// and the Ledger's "Staff Name" filter can show everyone ever added; only
// active staff are offered in the voucher creation dropdown (see
// getActiveStaffMembers()).
async function loadStaffMembers() {
  const { data, error } = await supabaseClient.from('staff_members').select('*').order('name');
  if (error) {
    console.error('Failed to load staff members:', error);
    return;
  }
  allStaffMembers = data || [];
  staffMembersById = new Map(allStaffMembers.map((s) => [s.id, s]));
}

function getActiveStaffMembers() {
  return allStaffMembers.filter((s) => s.active);
}

// Builds the <option> lists for the Filters modal's selects. Values are set
// separately each time the modal opens (see renderFiltersModalFromDraft()),
// not here -- this only needs to re-run when the owners/staff cache changes.
function populateOwnerFilterSelect() {
  filtersOwnerSelect.innerHTML = '<option value="">All Owners</option>' +
    allOwners.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}${o.active ? '' : ' (disabled)'}</option>`).join('');
}

function populateStaffFilterSelect() {
  filtersStaffSelect.innerHTML = '<option value="">All Staff</option>' +
    allStaffMembers.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}${s.active ? '' : ' (disabled)'}</option>`).join('');
}

function populateSettlementOwnerSelect() {
  settlementOwnerSelect.innerHTML = '<option value="">Select owner…</option>' +
    getActiveOwners().map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('');
}

// Required dropdown on the voucher creation form -- only active staff are
// offered, but create_voucher re-validates active status server-side too.
function populateMadeByStaffSelect() {
  const previousValue = madeByStaffSelect.value;
  madeByStaffSelect.innerHTML = '<option value="">Select staff…</option>' +
    getActiveStaffMembers().map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  madeByStaffSelect.value = previousValue;
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
  if (currentStaffFilter) params.p_made_by_staff_id = currentStaffFilter;

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

// --- Number formatting ---

// Whole numbers everywhere -- this business doesn't use decimal places.
// Comma-grouped; a value that technically carries cents internally still
// displays clean (1250.5 -> "1,251") since maximumFractionDigits: 0 rounds
// rather than truncates. This only affects display text -- internal
// storage/calculation precision (qty * price, sums) is untouched.
function formatWholeNumber(n) {
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// Shrinks the font size (down to a floor) only as much as needed so `text`
// fits within maxWidth on this canvas context -- a very large number must
// never bleed into a neighboring column or past the voucher's outer
// border. Mutates ctx.font as a side effect; the caller's subsequent
// fillText() uses whatever size this settles on. Used by
// renderCompositeVoucher() for the Qty/Price/Amount/Total columns.
function fitCanvasTextToWidth(ctx, text, maxWidth, baseFontSize, fontFamily, minFontSize = 10) {
  let fontSize = baseFontSize;
  ctx.font = `bold ${fontSize}px ${fontFamily}`;
  // Math.max clamps the last step exactly at the floor instead of one past
  // it -- decrementing unconditionally can overshoot by ~1px on the final
  // iteration since the loop condition is only checked *before* each step.
  while (ctx.measureText(text).width > maxWidth && fontSize > minFontSize) {
    fontSize = Math.max(fontSize - 1, minFontSize);
    ctx.font = `bold ${fontSize}px ${fontFamily}`;
  }
}

// Hard backstop behind fitCanvasTextToWidth -- clips drawing to a
// rectangle so even an absurdly long string (past what the shrink floor
// can still accommodate) is cropped at the column boundary instead of
// painting over a neighboring column or past the voucher's outer border.
function drawClippedText(ctx, rectX, rectY, rectW, rectH, drawFn) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rectX, rectY, rectW, rectH);
  ctx.clip();
  drawFn();
  ctx.restore();
}

// DOM equivalent of fitCanvasTextToWidth -- shrinks an element's own
// font-size (down to a floor) only if its content actually overflows its
// box, resetting to the CSS-declared base size first so a later, shorter
// value isn't stuck at a previously-shrunk size.
function fitTextElementToWidth(el, minFontSizePx = 11) {
  if (!el.dataset.baseFontSize) {
    el.dataset.baseFontSize = parseFloat(getComputedStyle(el).fontSize);
  }
  let fontSize = parseFloat(el.dataset.baseFontSize);
  el.style.fontSize = `${fontSize}px`;
  while (el.scrollWidth > el.clientWidth && fontSize > minFontSizePx) {
    fontSize = Math.max(fontSize - 1, minFontSizePx);
    el.style.fontSize = `${fontSize}px`;
  }
}

// --- Dashboard ---

const fmtMoney = (n) => '$' + formatWholeNumber(n);

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

// Owner/Admin only -- get_dashboard_summary enforces this independently on
// the backend (see supabase/schema.sql), so this is UX, not the actual
// security boundary. Still worth checking before opening the modal at all
// -- e.g. if something calls this directly (console, a stale button state)
// -- it fails with a clear message instead of a confusing RPC error after
// the modal is already open.
function openDashboard() {
  if (!isOwnerAdmin()) {
    showToast('Access denied -- the Dashboard is for Owner/Admin only.', 'error');
    return;
  }
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
// currentStatusFilter mechanism the search box and Filters modal already
// drive -- no separate filtering path needed. renderActiveFilterChips()
// (not direct DOM manipulation of the modal's chips) keeps the sidebar's
// badge/chips in sync; the modal itself re-derives its own state from
// currentStatusFilter the next time it's opened (see openLedgerFilters()).
function jumpToCustomerLedger(customerName, customerPhone) {
  closeDashboard();

  currentStatusFilter = 'unpaid';
  renderActiveFilterChips();

  currentSearchQuery = (customerPhone || customerName || '').toLowerCase().trim();
  searchInput.value = customerPhone || customerName || '';
  searchClearBtn.hidden = !currentSearchQuery;

  if (isSidebarOverlayViewport()) {
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
  if (currentStaffFilter && v.made_by_staff_id !== currentStaffFilter) return false;

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

// --- Staff Management (Owner/Admin only -- enforced server-side too) ---
// Mirrors Owner Management above exactly (same shape: id/name/active, same
// add/update/set-active RPC pattern) -- kept as a separate, parallel
// implementation rather than a shared abstraction, since owners and staff
// are conceptually distinct entities that happen to share a shape today.

async function openStaffMgmt() {
  staffMgmtModal.classList.add('active');
  editingStaffId = null;
  staffListLoading.hidden = false;
  await loadStaffMembers();
  staffListLoading.hidden = true;
  renderStaffList(allStaffMembers);
}

function closeStaffMgmt() {
  staffMgmtModal.classList.remove('active');
  editingStaffId = null;
}

function renderStaffList(staffMembers) {
  staffListEl.querySelectorAll('.owner-row, .owner-edit-form, .owner-empty-row').forEach((el) => el.remove());

  if (staffMembers.length === 0) {
    staffListEl.insertAdjacentHTML('beforeend', '<div class="owner-empty-row">No staff names yet. Add one above.</div>');
    return;
  }

  staffMembers.forEach((s) => {
    if (editingStaffId === s.id) {
      staffListEl.insertAdjacentHTML('beforeend', `
        <form class="owner-edit-form" data-staff-id="${s.id}">
          <input type="text" class="owner-edit-input" value="${escapeHtml(s.name)}" required>
          <button type="submit" class="btn btn-secondary">Save</button>
          <button type="button" class="btn btn-secondary staff-cancel-edit-btn">Cancel</button>
        </form>
      `);
      return;
    }

    staffListEl.insertAdjacentHTML('beforeend', `
      <div class="owner-row" data-staff-id="${s.id}">
        <div class="owner-row-info">
          <span class="owner-row-name">${escapeHtml(s.name)}</span>
          <span class="status-pill sm ${s.active ? 'is-paid' : 'is-void'}">${s.active ? 'Active' : 'Disabled'}</span>
        </div>
        <div class="owner-row-actions">
          <button class="btn btn-secondary staff-edit-btn" data-staff-id="${s.id}">Edit</button>
          <button class="btn btn-secondary ${s.active ? 'text-danger' : ''} staff-toggle-btn" data-staff-id="${s.id}" data-active="${s.active}">${s.active ? 'Disable' : 'Enable'}</button>
        </div>
      </div>
    `);
  });
}

// Refreshes every place the staff cache feeds: the management list itself,
// the Ledger's "Staff Name" filter, and the voucher creation dropdown.
async function refreshStaffEverywhere() {
  await loadStaffMembers();
  renderStaffList(allStaffMembers);
  populateStaffFilterSelect();
  populateMadeByStaffSelect();
}

staffAddForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = staffAddNameInput.value.trim();
  if (!name) return;

  const submitBtn = staffAddForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  const { data, error } = await supabaseClient.rpc('add_staff_member', { p_name: name });
  submitBtn.disabled = false;

  if (error) {
    console.error('Failed to add staff member:', error);
    showToast('Failed to add staff: ' + describeRpcError(error), 'error');
    return;
  }

  staffAddNameInput.value = '';
  await refreshStaffEverywhere();
  showToast(`Staff "${data.name}" added.`, 'success');
});

staffListEl.addEventListener('click', async (e) => {
  const editBtn = e.target.closest('.staff-edit-btn');
  if (editBtn) {
    editingStaffId = editBtn.dataset.staffId;
    renderStaffList(allStaffMembers);
    return;
  }

  const cancelBtn = e.target.closest('.staff-cancel-edit-btn');
  if (cancelBtn) {
    editingStaffId = null;
    renderStaffList(allStaffMembers);
    return;
  }

  const toggleBtn = e.target.closest('.staff-toggle-btn');
  if (toggleBtn) {
    const staffId = toggleBtn.dataset.staffId;
    const isActive = toggleBtn.dataset.active === 'true';
    const staff = staffMembersById.get(staffId);
    const verb = isActive ? 'disable' : 're-enable';
    const ok = await showConfirm(
      `Are you sure you want to ${verb} staff name "${staff ? staff.name : ''}"?`,
      { confirmLabel: isActive ? 'Disable' : 'Enable', danger: isActive }
    );
    if (!ok) return;

    toggleBtn.disabled = true;
    const { data, error } = await supabaseClient.rpc('set_staff_member_active', { p_staff_id: staffId, p_active: !isActive });
    toggleBtn.disabled = false;

    if (error) {
      console.error('Failed to update staff member:', error);
      showToast('Failed to update staff: ' + describeRpcError(error), 'error');
      return;
    }

    await refreshStaffEverywhere();
    showToast(`Staff "${data.name}" ${data.active ? 'enabled' : 'disabled'}.`, 'success');
  }
});

staffListEl.addEventListener('submit', async (e) => {
  const form = e.target.closest('.owner-edit-form');
  if (!form) return;
  e.preventDefault();

  const staffId = form.dataset.staffId;
  const input = form.querySelector('.owner-edit-input');
  const name = input.value.trim();
  if (!name) return;

  const { data, error } = await supabaseClient.rpc('update_staff_member', { p_staff_id: staffId, p_name: name });
  if (error) {
    console.error('Failed to update staff member:', error);
    showToast('Failed to update staff: ' + describeRpcError(error), 'error');
    return;
  }

  editingStaffId = null;
  await refreshStaffEverywhere();
  showToast(`Staff renamed to "${data.name}".`, 'success');
});

openStaffMgmtBtn.addEventListener('click', openStaffMgmt);
closeStaffMgmtBtn.addEventListener('click', closeStaffMgmt);

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

  // Row clear buttons -- mode-aware: clears whichever input the row is
  // currently in (canvas+strokes for handwriting, the text field for
  // typing), not both. The other mode's data is untouched, consistent with
  // switching modes itself never discarding data (see setRowMode()).
  document.querySelectorAll('.clear-row-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const rowIdx = parseInt(e.target.dataset.row);
      const toggleBtn = document.querySelector(`.row-mode-toggle-btn[data-row="${rowIdx}"]`);
      const mode = toggleBtn ? toggleBtn.dataset.mode : 'handwriting';

      if (mode === 'typing') {
        const typedInput = document.querySelector(`.row-typed-input[data-row="${rowIdx}"]`);
        if (typedInput) typedInput.value = '';
        return;
      }

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

// Item Name mode (Handwriting/Typing) -- per-row, never deletes the other
// mode's data on switch (see handleSaveVoucher()/clearAllCanvases() for the
// only places that actually discard it: a real save, or a full reset).
function setRowMode(rowIdx, mode) {
  const toggleBtn = document.querySelector(`.row-mode-toggle-btn[data-row="${rowIdx}"]`);
  const canvas = document.querySelector(`.row-canvas[data-row="${rowIdx}"]`);
  const typedInput = document.querySelector(`.row-typed-input[data-row="${rowIdx}"]`);
  if (!toggleBtn || !canvas || !typedInput) return;

  toggleBtn.dataset.mode = mode;
  toggleBtn.title = mode === 'handwriting' ? 'Switch to typing mode' : 'Switch to handwriting mode';
  // toggleAttribute, not .hidden -- SVGElement (unlike HTMLElement) doesn't
  // reflect the .hidden JS property to the actual hidden="" attribute in
  // this engine, so [hidden]'s CSS rule would never match and both icons
  // would stay visibly stacked. toggleAttribute works on any element.
  toggleBtn.querySelector('.mode-icon-handwriting').toggleAttribute('hidden', mode !== 'handwriting');
  toggleBtn.querySelector('.mode-icon-typing').toggleAttribute('hidden', mode !== 'typing');

  canvas.hidden = mode !== 'handwriting';
  typedInput.hidden = mode !== 'typing';
}

function setupRowModeToggles() {
  document.querySelectorAll('.row-mode-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rowIdx = btn.dataset.row;
      const nextMode = btn.dataset.mode === 'typing' ? 'handwriting' : 'typing';
      setRowMode(rowIdx, nextMode);
    });
  });
}

function getRowNameMode(rowIdx) {
  const toggleBtn = document.querySelector(`.row-mode-toggle-btn[data-row="${rowIdx}"]`);
  return toggleBtn && toggleBtn.dataset.mode === 'typing' ? 'typing' : 'handwriting';
}

// Bulk shortcut for the common case of wanting every row the same mode --
// the per-row toggle above still lets staff mix both on one voucher.
// Non-destructive (same as a single-row toggle), so no confirmation.
function setAllRowsMode(mode) {
  for (let i = 0; i < 8; i++) {
    setRowMode(i, mode);
  }
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

    // data-amount holds the raw number for downstream re-use (grand total
    // sum, the A5 canvas export) -- textContent is comma-formatted for
    // display ("1,250"), which parseFloat() would mangle (parseFloat
    // stops at the comma, reading "1,250" as 1) if anything tried to
    // re-parse it directly instead.
    if (qty > 0 && price > 0) {
      amountVal.textContent = formatWholeNumber(amount);
      amountVal.dataset.amount = amount;
      fitTextElementToWidth(amountVal);
      amountVal.classList.remove('is-zero');
    } else {
      amountVal.textContent = '';
      amountVal.dataset.amount = '0';
      amountVal.classList.add('is-zero');
    }

    recalculateGrandTotal();
  };

  const recalculateGrandTotal = () => {
    let grandTotal = 0;
    document.querySelectorAll('.amount-val').forEach((amountEl) => {
      grandTotal += parseFloat(amountEl.dataset.amount) || 0;
    });

    const grandTotalEl = document.getElementById('grand-total-val');
    if (grandTotal > 0) {
      grandTotalEl.textContent = formatWholeNumber(grandTotal);
      grandTotalEl.dataset.amount = grandTotal;
      fitTextElementToWidth(grandTotalEl);
      grandTotalEl.classList.remove('is-zero');
    } else {
      grandTotalEl.textContent = '';
      grandTotalEl.dataset.amount = '0';
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
    eCtx.font = 'bold 22px "Noto Sans Myanmar", "Courier Prime", Courier, monospace';
    eCtx.fillText(companyInfo.name, 48, 40);

    if (companyInfo.addressLine) {
      eCtx.font = '12px "Noto Sans Myanmar", "Courier Prime", Courier, monospace';
      eCtx.fillStyle = 'rgba(15, 23, 42, 0.6)';
      eCtx.fillText(companyInfo.addressLine, 48, 60);
      eCtx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    }

    eCtx.font = 'bold 28px "Noto Sans Myanmar", "Courier Prime", Courier, monospace';
    eCtx.fillText('PAYMENT VOUCHER', 48, 96);

    // Customer (Bill To)
    eCtx.font = '11px "Noto Sans Myanmar", "Courier Prime", Courier, monospace';
    eCtx.fillStyle = 'rgba(15, 23, 42, 0.55)';
    eCtx.fillText('BILL TO', 48, 116);

    eCtx.font = 'bold 17px "Noto Sans Myanmar", "Courier Prime", Courier, monospace';
    eCtx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    const customerLine = customerPhone ? `${customerName}  ·  ${customerPhone}` : customerName;
    eCtx.fillText(customerLine, 48, 138);

    // Metadata (Voucher ID & Selected Date)
    eCtx.textAlign = 'right';
    eCtx.font = '16px "Noto Sans Myanmar", "Courier Prime", Courier, monospace';
    eCtx.fillText('VOUCHER NO.', 1112, 55);
    eCtx.font = 'bold 22px "Noto Sans Myanmar", "Courier Prime", Courier, monospace';
    eCtx.fillText(formatVoucherID(sequenceNum), 1112, 80);

    eCtx.font = '16px "Noto Sans Myanmar", "Courier Prime", Courier, monospace';
    eCtx.fillText('DATE', 1112, 108);
    eCtx.font = 'bold 18px "Noto Sans Myanmar", "Courier Prime", Courier, monospace';
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
    eCtx.font = 'bold 14px "Noto Sans Myanmar", "Courier Prime", Courier, monospace';
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
      
      const cellFontFamily = '"Noto Sans Myanmar", "Courier Prime", Courier, monospace';
      const rowY = tableTop + headerHeight + i * rowHeight;

      // Draw Quantity -- not "money," so no comma-grouping, but still
      // protected from overflowing its column the same as Price/Amount.
      // drawClippedText() is a hard backstop behind fitCanvasTextToWidth's
      // font-shrinking: an unrealistically long value could otherwise
      // still bleed past the column even at the shrink floor.
      const qty = qtyInput ? qtyInput.value : '';
      if (qty && qty !== '0') {
        fitCanvasTextToWidth(eCtx, qty, colQtyWidth - 16, 18, cellFontFamily);
        drawClippedText(eCtx, xQty, rowY, colQtyWidth, rowHeight, () => {
          eCtx.fillStyle = 'rgba(15, 23, 42, 0.9)';
          eCtx.fillText(qty, xQty + colQtyWidth / 2, yCenter);
        });
      }

      // Draw Price -- whole number, comma-grouped (the business doesn't
      // use decimal places), font shrinks to fit if it would otherwise
      // overflow the column.
      const price = priceInput ? parseFloat(priceInput.value) || 0 : 0;
      if (price > 0) {
        const priceText = formatWholeNumber(price);
        fitCanvasTextToWidth(eCtx, priceText, colPriceWidth - 16, 18, cellFontFamily);
        drawClippedText(eCtx, xPrice, rowY, colPriceWidth, rowHeight, () => {
          eCtx.fillStyle = 'rgba(15, 23, 42, 0.9)';
          eCtx.fillText(priceText, xPrice + colPriceWidth / 2, yCenter);
        });
      }

      // Draw Calculated Amount (with blue stamped ink style). Reads the
      // raw value from data-amount, not the displayed text -- amountVal's
      // textContent is now comma-formatted ("1,250"), and parseFloat()
      // would mangle that (it stops at the comma, reading just "1").
      const amount = amountVal ? parseFloat(amountVal.dataset.amount) || 0 : 0;
      if (amount > 0) {
        const amountText = formatWholeNumber(amount);
        eCtx.textAlign = 'right';
        fitCanvasTextToWidth(eCtx, amountText, colAmountWidth - 32, 18, cellFontFamily);
        drawClippedText(eCtx, xAmount, rowY, colAmountWidth, rowHeight, () => {
          eCtx.fillStyle = '#1d4ed8'; // Stamped Blue Ink
          eCtx.fillText(amountText, xAmount + colAmountWidth - 24, yCenter);
        });
        eCtx.textAlign = 'center'; // reset
      }
      
      // Draw item name -- typed text (left-aligned, like reading direction)
      // for a Typing-mode row, otherwise the handwriting canvas image as
      // before. textAlign is reset back to 'center' right after, same as
      // the Amount column above, since the rest of this loop assumes it.
      if (getRowNameMode(i) === 'typing') {
        const typedInput = document.querySelector(`.row-typed-input[data-row="${i}"]`);
        const typedName = typedInput ? typedInput.value.trim() : '';
        if (typedName) {
          eCtx.font = 'bold 18px "Noto Sans Myanmar", "Courier Prime", Courier, monospace';
          eCtx.fillStyle = 'rgba(15, 23, 42, 0.9)';
          eCtx.textAlign = 'left';
          eCtx.fillText(typedName, xDesc + 12, yCenter, colDescWidth - 24);
          eCtx.textAlign = 'center'; // reset
        }
      } else {
        const rowCanvasEl = rowCanvases[i];
        if (rowCanvasEl) {
          eCtx.drawImage(rowCanvasEl, xDesc, tableTop + headerHeight + i * rowHeight, colDescWidth, rowHeight);
        }
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
    
    eCtx.font = '14px "Noto Sans Myanmar", "Courier Prime", Courier, monospace';
    eCtx.fillStyle = 'rgba(15, 23, 42, 0.7)';
    eCtx.textAlign = 'center';
    eCtx.textBaseline = 'alphabetic';
    eCtx.fillText('AUTHORIZED SIGNATURE', 288, footerTop + 95);
    
    // Draw Signature canvas ink overlay
    eCtx.drawImage(sigCanvas, 48, footerTop + 15, 480, 104);
    
    // Grand Total box
    eCtx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    eCtx.font = 'bold 15px "Noto Sans Myanmar", "Courier Prime", Courier, monospace';
    eCtx.textAlign = 'right';
    eCtx.fillText('TOTAL AMOUNT ($)', 832, footerTop + 45);
    
    eCtx.strokeRect(852, footerTop + 15, 260, 76);
    
    // Print grand total value -- already comma-formatted, whole-number
    // text from grand-total-val (see recalculateGrandTotal()); just
    // drawn directly, never re-parsed as a number here, so the comma
    // formatting is safe as-is. Font shrinks to fit the 260px total box
    // if the total is large enough to otherwise overflow it, with
    // drawClippedText() as the hard backstop behind that, same reasoning
    // as the Qty/Price/Amount columns above.
    const grandTotal = document.getElementById('grand-total-val').textContent;
    fitCanvasTextToWidth(eCtx, grandTotal, 260 - 32, 24, '"Noto Sans Myanmar", "Courier Prime", Courier, monospace');
    eCtx.textAlign = 'right';
    drawClippedText(eCtx, 852, footerTop + 15, 260, 76, () => {
      eCtx.fillStyle = 'rgba(15, 23, 42, 0.95)';
      eCtx.fillText(grandTotal, 1112 - 24, footerTop + 55);
    });
    
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
      
      eCtx.font = 'bold 64px "Noto Sans Myanmar", "Courier Prime", Courier, monospace';
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
          <span class="card-total">${fmtMoney(v.total_amount)}</span>
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
  // made_by_staff_name is null on vouchers saved before this feature
  // existed -- nothing to show for those rather than a misleading blank line.
  modalMadeBy.textContent = voucher.made_by_staff_name ? `Made By: ${voucher.made_by_staff_name}` : '';
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

// 1 = "fit to screen" (the default, no explicit size -- handled by CSS
// max-width/max-height: 100%). Anything after that sets an explicit pixel
// width based on the image's natural size, which is what gives
// lightbox-body's overflow: auto something real to scroll/pan across.
const LIGHTBOX_ZOOM_LEVELS = [1, 1.25, 1.5, 2, 2.5, 3];
let lightboxZoomIndex = 0;

function applyLightboxZoom() {
  if (lightboxZoomIndex === 0) {
    lightboxImg.classList.remove('is-zoomed');
    lightboxImg.style.width = '';
  } else {
    lightboxImg.classList.add('is-zoomed');
    const factor = LIGHTBOX_ZOOM_LEVELS[lightboxZoomIndex];
    const naturalWidth = lightboxImg.naturalWidth || 1160;
    lightboxImg.style.width = `${Math.round(naturalWidth * factor)}px`;
  }
  lightboxZoomOutBtn.disabled = lightboxZoomIndex === 0;
  lightboxZoomInBtn.disabled = lightboxZoomIndex === LIGHTBOX_ZOOM_LEVELS.length - 1;
}

// Reuses modalVoucherImg's already-resolved signed URL -- no need to
// refetch, the detail modal must already be open (and that image loaded)
// for the expand button to be visible at all.
function openVoucherLightbox() {
  lightboxImg.src = modalVoucherImg.src;
  lightboxTitle.textContent = modalVoucherId.textContent;
  lightboxZoomIndex = 0;
  applyLightboxZoom();
  lightboxBody.scrollTop = 0;
  lightboxBody.scrollLeft = 0;
  voucherLightbox.classList.add('active');
}

function closeVoucherLightbox() {
  voucherLightbox.classList.remove('active');
}

// Reset form fields
function clearVoucherFields() {
  document.querySelectorAll('.qty-input').forEach(i => i.value = '');
  document.querySelectorAll('.price-input').forEach(i => i.value = '');
  document.querySelectorAll('.amount-val').forEach(a => {
    a.textContent = '';
    a.dataset.amount = '0'; // not just textContent -- renderCompositeVoucher() reads this directly, a stale value here would draw a phantom amount on the next voucher
    a.classList.add('is-zero');
  });
  const grandTotalEl = document.getElementById('grand-total-val');
  grandTotalEl.textContent = '';
  grandTotalEl.dataset.amount = '0';
  grandTotalEl.classList.add('is-zero');
  customerNameInput.value = '';
  customerPhoneInput.value = '';
  // Reset, not sticky -- on a tablet shared by several staff, carrying the
  // previous voucher's selection forward risks silently misattributing the
  // next one to whoever made the last sale.
  madeByStaffSelect.value = '';
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

  // Full reset (called after a successful save, and by "Clear Entire
  // Voucher") -- unlike a mode switch or the per-row clear button, this is
  // the one place that's supposed to wipe everything, so typed text and
  // mode both go back to defaults too.
  document.querySelectorAll('.row-typed-input').forEach((input) => { input.value = ''; });
  rowCanvases.forEach((canvas) => setRowMode(canvas.dataset.row, 'handwriting'));
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

// printMode: 'none' (Save Only) | 'a5' (Print A5 Voucher) | 'receipt'
// (Print 80mm Receipt) -- which one, if any, is decided by the Save &
// Print choice modal before this is ever called; see openSavePrintChoiceModal().
async function handleSaveVoucher({ printMode = 'none' } = {}) {
  if (isSaving) return; // belt-and-suspenders against a double-click slipping through

  // Required -- checked before reserve_voucher_sequence_number below, not
  // after, because Postgres sequences don't roll back: failing this check
  // post-reservation would permanently burn a voucher number for a save
  // that was never going to succeed.
  const madeByStaffId = madeByStaffSelect.value;
  if (!madeByStaffId) {
    showToast('Select who made this voucher (Made By) before saving.', 'error');
    return;
  }

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
  // copy is only used to render the composite PNG. nameMode/typedName are
  // read straight from the DOM, same as qty/price -- no separate JS state
  // tracks them, the mode toggle button's own data-mode attribute IS the
  // state (see setRowMode()).
  const items = [];
  for (let i = 0; i < 8; i++) {
    const qtyVal = parseFloat(document.querySelector(`.qty-input[data-row="${i}"]`).value) || 0;
    const priceVal = parseFloat(document.querySelector(`.price-input[data-row="${i}"]`).value) || 0;
    const nameMode = getRowNameMode(i);
    const typedInput = document.querySelector(`.row-typed-input[data-row="${i}"]`);
    const typedName = nameMode === 'typing' ? (typedInput ? typedInput.value.trim() : '') : '';
    items.push({ rowIndex: i, qty: qtyVal, price: priceVal, nameMode, typedName });
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
      p_made_by_staff_id: madeByStaffId,
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

    if (printMode === 'a5') {
      await PrintService.printVoucher(finalVoucher);
      showToast(`Voucher ${displayId} saved and sent to print.`, 'success');
    } else if (printMode === 'receipt') {
      await PrintService.printThermalReceipt(finalVoucher);
      showToast(`Voucher ${displayId} saved and receipt sent to print.`, 'success');
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
  [markPaidBtn, markUnpaidBtn, voidBtn, printBtn, printThermalBtn, downloadBtn, markSettlementReceivedBtn, markSettlementNotReceivedBtn].forEach((btn) => {
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

// Phase 1 of 80mm thermal receipt printing: plain browser window.print()
// through the Android Print Framework to whatever print service the
// printer (e.g. XP-80T) registers -- no ESC/POS, no handwriting images
// (handwriting only exists as ink in the canvas, with no typed equivalent,
// so it can never appear as text here -- typed-mode rows are the only
// ones that ever get a name line, see buildThermalReceiptHtml below).
// Deliberately omits Staff/Made By -- that's internal-only and must never
// appear on anything customer-facing, same rule as the A5 voucher/PDF (see
// buildPrintHtml below, which also never reads it).
//
// Item rows/total use formatWholeNumber() (whole numbers, comma-grouped,
// no currency symbol) -- the same one Dashboard/ledger/A5 use now, after
// this used to keep its own near-identical copy that still allowed up to
// 2 decimal places.

function buildThermalReceiptHtml(voucher) {
  const displayId = formatVoucherID(voucher.sequence_number);
  const dateParts = voucher.date.split('-');
  const dateDisplay = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;
  const status = getStatusBadgeInfo(voucher);
  const shopName = (companySettings && companySettings.company_name) || 'InkVoucher';
  const shopNote = companySettings
    ? [companySettings.address, companySettings.phone].filter(Boolean).join(' · ')
    : '';
  const customerLine = voucher.customer_phone
    ? `${voucher.customer_name} · ${voucher.customer_phone}`
    : voucher.customer_name;
  // Saved items always have all 8 rows (many zeroed out for whatever the
  // customer didn't fill in) -- only the ones actually filled in are worth
  // printing, same filter renderCompositeVoucher() uses for the A5 PNG.
  const itemRows = (voucher.items || []).filter((it) => Number(it.amount) > 0);

  // Typed-mode rows get a name line above the qty/price/amount line
  // ("Steel Pipe 1/2 inch" / "20 × 20,000 = 400,000"); handwriting rows
  // (no typedName) keep the existing single numbered line unchanged.
  // Checked on typedName directly, not nameMode, so this is correct even
  // for any historical row whose mode/text combination doesn't line up
  // perfectly -- if there's real typed text, show it; if not, don't.
  const itemLines = itemRows.map((it, idx) => {
    const calcLine = `${formatWholeNumber(it.qty)} × ${formatWholeNumber(it.price)} = ${formatWholeNumber(it.amount)}`;
    const typedName = (it.typedName || '').trim();
    if (typedName) {
      return `<div>${escapeHtml(typedName)}</div><div>${calcLine}</div>`;
    }
    return `<div>${idx + 1}) ${calcLine}</div>`;
  }).join('\n    ');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${displayId}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Myanmar:wght@400;700&display=swap" rel="stylesheet">
<style>
  @page {
    size: 80mm auto;
    margin: 3mm;
  }
  html, body {
    width: 80mm;
    margin: 0;
    padding: 0;
    background: white;
    color: black;
  }
  .receipt {
    width: 72mm;
    font-size: 11px;
    line-height: 1.35;
    /* Noto Sans Myanmar first so typed Burmese item names actually have
       glyph coverage -- confirmed against tests/burmese-font-rendering-spike.html
       before this was wired in, same reasoning as the A5 canvas renderer. */
    font-family: 'Noto Sans Myanmar', 'Courier New', Courier, monospace;
  }
  .center { text-align: center; }
  .bold { font-weight: 700; }
  .divider { border-top: 1px dashed #000; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; gap: 6px; }
  .total { font-size: 14px; font-weight: 700; }
  @media print {
    body {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
  }
</style>
</head>
<body>
  <div class="receipt">
    <div class="center bold">${escapeHtml(shopName)}</div>
    ${shopNote ? `<div class="center">${escapeHtml(shopNote)}</div>` : ''}
    <div class="divider"></div>
    <div class="row"><span>Voucher #</span><span class="bold">${displayId}</span></div>
    <div class="row"><span>Date</span><span>${dateDisplay}</span></div>
    <div class="row"><span>Customer</span><span>${escapeHtml(customerLine)}</span></div>
    <div class="row"><span>Payment</span><span>${escapeHtml(voucher.payment_method)}</span></div>
    <div class="row"><span>Status</span><span class="bold">${status.label}</span></div>
    ${itemRows.length > 0 ? `
    <div class="divider"></div>
    <div class="bold">Items</div>
    ${itemLines}
    ` : ''}
    <div class="divider"></div>
    <div class="row total"><span>Total</span><span>${formatWholeNumber(voucher.total_amount)}</span></div>
    <div class="divider"></div>
    <div class="center">Thank you!</div>
  </div>
</body>
</html>`;
}

// All printing goes through here -- printVoucher/printThermalReceipt are
// the only two entry points the rest of the app calls. Keeping window.print()
// confined to this object means a later swap to a native Android/XPrinter
// SDK only touches these two methods, not every call site.
const PrintService = {
  async printVoucher(voucher) {
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
  },

  async printThermalReceipt(voucher) {
    const { data: updated, error } = await supabaseClient.rpc('log_voucher_print', { p_voucher_id: voucher.id });
    if (error) {
      console.error('Error logging print:', error);
      showToast('Failed to print: ' + describeRpcError(error), 'error');
      return voucher;
    }

    patchVoucherInLocalState(updated);

    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(buildThermalReceiptHtml(updated));
      printWindow.document.close();
      // Unlike the A5 path (an <img>, already-rasterized, no font timing
      // concern), this window renders live text -- window.onload can fire
      // before the Noto Sans Myanmar webfont actually finishes loading, so
      // printing on bare onload risks falling back to a font with no
      // Myanmar glyphs for that one print. Wait for document.fonts.ready
      // first; fall back to printing immediately if the API isn't there.
      printWindow.onload = () => {
        if (printWindow.document.fonts && printWindow.document.fonts.ready) {
          printWindow.document.fonts.ready.then(() => printWindow.print());
        } else {
          printWindow.print();
        }
      };
    } else {
      showToast('Could not open the print window -- check your browser\'s pop-up blocker.', 'error');
    }
    return updated;
  },
};

async function handlePrintActiveVoucher() {
  if (!activeVoucher) return;
  setModalActionsLoading(true);
  activeVoucher = await PrintService.printVoucher(activeVoucher);
  setModalActionsLoading(false);
  updateModalFromVoucher(activeVoucher);
}

async function handlePrintThermalActiveVoucher() {
  if (!activeVoucher) return;
  setModalActionsLoading(true);
  activeVoucher = await PrintService.printThermalReceipt(activeVoucher);
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

// --- Ledger Filters modal -- draft/apply pattern (see filtersDraft above) ---

// Declarative list of what's currently active, driving the sidebar's
// badge count and removable chips AND (deliberately) the only place that
// knows how to label/clear each filter -- adding a future filter means
// adding one entry here plus its modal control, not restructuring this
// rendering/badge system again.
function getActiveFilterDescriptors() {
  const list = [];
  const statusLabels = { active: 'Active', paid: 'Paid', unpaid: 'Unpaid', void: 'Void' };
  const dateLabels = { today: 'Today', yesterday: 'Yesterday', week: 'This Week', month: 'This Month' };

  if (currentStatusFilter !== 'all') {
    list.push({
      key: 'status',
      label: statusLabels[currentStatusFilter] || currentStatusFilter,
      onRemove: () => { currentStatusFilter = 'all'; },
    });
  }
  if (currentDateRange) {
    const label = dateLabels[currentDatePreset] || `${currentDateRange.from} – ${currentDateRange.to}`;
    list.push({
      key: 'date',
      label,
      onRemove: () => { currentDateRange = null; currentDatePreset = 'all'; },
    });
  }
  if (currentStaffFilter) {
    const staff = staffMembersById.get(currentStaffFilter);
    list.push({
      key: 'staff',
      label: `Staff: ${staff ? staff.name : 'Unknown'}`,
      onRemove: () => { currentStaffFilter = ''; },
    });
  }
  if (currentSettlementFilter) {
    list.push({
      key: 'settlement',
      label: currentSettlementFilter,
      onRemove: () => { currentSettlementFilter = ''; },
    });
  }
  if (currentOwnerFilter) {
    const owner = ownersById.get(currentOwnerFilter);
    list.push({
      key: 'owner',
      label: `Received By: ${owner ? owner.name : 'Unknown'}`,
      onRemove: () => { currentOwnerFilter = ''; },
    });
  }
  return list;
}

function renderActiveFilterChips() {
  const chips = getActiveFilterDescriptors();

  activeFilterChipsEl.innerHTML = chips.map((c) => `
    <span class="active-chip" data-key="${c.key}">
      ${escapeHtml(c.label)}
      <button class="active-chip-remove" data-key="${c.key}" aria-label="Remove ${escapeHtml(c.label)} filter">×</button>
    </span>
  `).join('');
  activeFilterChipsEl.hidden = chips.length === 0;

  filtersBadge.textContent = String(chips.length);
  filtersBadge.hidden = chips.length === 0;
}

activeFilterChipsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.active-chip-remove');
  if (!btn) return;
  const descriptor = getActiveFilterDescriptors().find((c) => c.key === btn.dataset.key);
  if (descriptor) descriptor.onRemove();
  renderActiveFilterChips();
  reloadVouchers();
});

// Reflects the modal's controls to match filtersDraft -- called whenever
// the modal opens (seeded from live state) and after Clear All (reset to
// defaults), so the controls and filtersDraft can never drift apart.
function renderFiltersModalFromDraft() {
  filtersStatusChipRow.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.filter === filtersDraft.status);
  });

  filtersDateSegmented.querySelectorAll('input[name="filters-date-preset"]').forEach((radio) => {
    radio.checked = radio.value === filtersDraft.datePreset;
  });
  filtersDateCustomRow.hidden = filtersDraft.datePreset !== 'custom';
  filtersDateFrom.value = filtersDraft.dateRange ? filtersDraft.dateRange.from : '';
  filtersDateTo.value = filtersDraft.dateRange ? filtersDraft.dateRange.to : '';

  filtersStaffSelect.value = filtersDraft.staffId;
  filtersSettlementSelect.value = filtersDraft.settlementStatus;
  filtersOwnerSelect.value = filtersDraft.ownerId;
}

function openLedgerFilters() {
  filtersDraft = {
    status: currentStatusFilter,
    datePreset: currentDatePreset,
    dateRange: currentDateRange,
    staffId: currentStaffFilter,
    settlementStatus: currentSettlementFilter,
    ownerId: currentOwnerFilter,
  };
  renderFiltersModalFromDraft();
  ledgerFiltersModal.classList.add('active');
}

function closeLedgerFilters() {
  ledgerFiltersModal.classList.remove('active');
}

function applyLedgerFilters() {
  currentStatusFilter = filtersDraft.status;
  currentDatePreset = filtersDraft.datePreset;
  currentDateRange = filtersDraft.dateRange;
  currentStaffFilter = filtersDraft.staffId;
  currentSettlementFilter = filtersDraft.settlementStatus;
  currentOwnerFilter = filtersDraft.ownerId;

  closeLedgerFilters();
  renderActiveFilterChips();
  reloadVouchers();
}

// Resets the draft and the modal's own controls -- does NOT touch the live
// filter state or reload the ledger. Stays open so Apply remains the only
// path that commits a change, rather than having two different "this took
// effect" behaviors to keep track of.
function clearAllFiltersDraft() {
  filtersDraft = {
    status: 'all',
    datePreset: 'all',
    dateRange: null,
    staffId: '',
    settlementStatus: '',
    ownerId: '',
  };
  renderFiltersModalFromDraft();
}

filtersStatusChipRow.addEventListener('click', (e) => {
  const chip = e.target.closest('.filter-chip');
  if (!chip) return;
  filtersDraft.status = chip.dataset.filter;
  renderFiltersModalFromDraft();
});

// Shares getDateRangeForPreset() with the Dashboard's own date range
// picker for identical Today/Yesterday/This Week/This Month math.
filtersDateSegmented.addEventListener('change', (e) => {
  if (e.target.name !== 'filters-date-preset') return;
  const preset = e.target.value;
  filtersDraft.datePreset = preset;
  filtersDraft.dateRange = preset === 'all' || preset === 'custom' ? (preset === 'custom' ? filtersDraft.dateRange : null) : getDateRangeForPreset(preset);
  renderFiltersModalFromDraft();
});

function handleFiltersDateCustomChange() {
  if (filtersDateFrom.value && filtersDateTo.value) {
    filtersDraft.dateRange = { from: filtersDateFrom.value, to: filtersDateTo.value };
  }
}
filtersDateFrom.addEventListener('change', handleFiltersDateCustomChange);
filtersDateTo.addEventListener('change', handleFiltersDateCustomChange);

filtersStaffSelect.addEventListener('change', () => { filtersDraft.staffId = filtersStaffSelect.value; });
filtersSettlementSelect.addEventListener('change', () => { filtersDraft.settlementStatus = filtersSettlementSelect.value; });
filtersOwnerSelect.addEventListener('change', () => { filtersDraft.ownerId = filtersOwnerSelect.value; });

openLedgerFiltersBtn.addEventListener('click', openLedgerFilters);
closeLedgerFiltersBtn.addEventListener('click', closeLedgerFilters);
filtersApplyBtn.addEventListener('click', applyLedgerFilters);
filtersClearAllBtn.addEventListener('click', clearAllFiltersDraft);

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

setAllHandwritingBtn.addEventListener('click', () => setAllRowsMode('handwriting'));
setAllTypingBtn.addEventListener('click', () => setAllRowsMode('typing'));

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

// "Save & Print" no longer assumes a format -- it just opens the choice
// modal; nothing is saved until one of the three action buttons inside it
// is actually clicked. The dedicated "Save Only" button bypasses the modal
// entirely, same as it always has.
function openSavePrintChoiceModal() {
  savePrintChoiceModal.classList.add('active');
}
function closeSavePrintChoiceModal() {
  savePrintChoiceModal.classList.remove('active');
}

saveOnlyBtn.addEventListener('click', () => handleSaveVoucher({ printMode: 'none' }));
savePrintBtn.addEventListener('click', openSavePrintChoiceModal);
closeSavePrintChoiceBtn.addEventListener('click', closeSavePrintChoiceModal);
choiceCancelBtn.addEventListener('click', closeSavePrintChoiceModal);

choicePrintA5Btn.addEventListener('click', () => {
  closeSavePrintChoiceModal();
  handleSaveVoucher({ printMode: 'a5' });
});
choicePrintReceiptBtn.addEventListener('click', () => {
  closeSavePrintChoiceModal();
  handleSaveVoucher({ printMode: 'receipt' });
});
choiceSaveOnlyBtn.addEventListener('click', () => {
  closeSavePrintChoiceModal();
  handleSaveVoucher({ printMode: 'none' });
});
searchInput.addEventListener('input', handleSearch);
searchClearBtn.addEventListener('click', handleClearSearch);
// Ledger Filters modal's own listeners are wired inline, right next to
// their handlers, above (openLedgerFilters/applyLedgerFilters/etc.).

// Modal details actions
closeModalBtn.addEventListener('click', closeVoucherDetail);
voidBtn.addEventListener('click', handleVoidActiveVoucher);
downloadBtn.addEventListener('click', handleDownloadActiveVoucher);
markPaidBtn.addEventListener('click', handleMarkPaid);
markUnpaidBtn.addEventListener('click', handleMarkUnpaid);
printBtn.addEventListener('click', handlePrintActiveVoucher);
printThermalBtn.addEventListener('click', handlePrintThermalActiveVoucher);
expandPreviewBtn.addEventListener('click', openVoucherLightbox);
closeLightboxBtn.addEventListener('click', closeVoucherLightbox);
lightboxZoomInBtn.addEventListener('click', () => {
  if (lightboxZoomIndex < LIGHTBOX_ZOOM_LEVELS.length - 1) {
    lightboxZoomIndex += 1;
    applyLightboxZoom();
  }
});
lightboxZoomOutBtn.addEventListener('click', () => {
  if (lightboxZoomIndex > 0) {
    lightboxZoomIndex -= 1;
    applyLightboxZoom();
  }
});
lightboxZoomFitBtn.addEventListener('click', () => {
  lightboxZoomIndex = 0;
  applyLightboxZoom();
});

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
// Must match index.css's `@media (max-width: 900px), (max-height: 820px)`
// exactly -- that's what switches .sidebar to position:absolute (an
// overlay drawer rather than a normal flex sibling). This was width-only
// for a while after the CSS breakpoint grew a height arm (to catch
// landscape tablets), which meant a wide-but-short viewport (e.g. a
// Galaxy Tab A8 in landscape, ~962x600) got the CSS's overlay behavior
// without ever being auto-collapsed for it -- the sidebar sat open on top
// of the workspace permanently, with no width-based trigger to close it,
// obscuring whatever was underneath (the footer's leftmost controls).
function isSidebarOverlayViewport() {
  return window.innerWidth <= 900 || window.innerHeight <= 820;
}

let sidebarWasNarrow = null;
function syncSidebarForViewport() {
  const isNarrow = isSidebarOverlayViewport();
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
      loadStaffMembers(),
    ]);
    companySettings = company;

    openOwnerMgmtBtn.hidden = !isOwnerAdmin();
    openStaffMgmtBtn.hidden = !isOwnerAdmin();
    openDashboardBtn.hidden = !isOwnerAdmin();
    populateOwnerFilterSelect();
    populateStaffFilterSelect();
    populateMadeByStaffSelect();

    await reloadVouchers();

    const maxSeqNum = currentVouchers.reduce((max, v) => Math.max(max, v.sequence_number), 0);
    nextSequenceNumber = maxSeqNum + 1;

    updateNextVoucherID();
    loadCurrentDate();
    setupCanvasListeners();
    setupRowModeToggles();
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
