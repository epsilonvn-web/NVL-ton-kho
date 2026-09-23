// ==========================================================================
// APP.JS - Toàn bộ logic xử lý ứng dụng tồn kho NVL
// Giao diện nằm ở index.html; dữ liệu/cấu hình tĩnh nằm ở assets/data/app-data.json
// ==========================================================================

// URL Google Apps Script API - lấy dữ liệu từ GGS "database" (đã IMPORTRANGE từ file kế toán)
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbx4VqKpT_h0suRstLds24ZQKPfvb7z9Mu7ZxVtsfYFpG3LN0j5j1AnOW5_d3DMXeuPE/exec";

// ============================================================================
// ACCOUNT / AUTH / SESSION / PERMISSION v2
// ----------------------------------------------------------------------------
// Người dùng đăng nhập bằng Email + Mật khẩu. UserId IPxxxxxx chỉ là khóa nội bộ.
// localStorage chỉ giữ session token; identity/role/permissions luôn được server xác minh lại.
// ============================================================================
const SESSION_KEY = 'vhip_session_token';
let currentUser = null; // { userId, email, name, department, role, token }
let currentPermissions = new Set();
let pendingRegistrationEmail = '';
let registrationOptions = { departments: [], roles: [] };
let ROLE_LABELS = {};
let ROLE_OPTIONS = [];
let STATUS_OPTIONS = [];
let PERMISSION_LABELS = {};

async function apiPost(action, payload) {
    const body = Object.assign({ action }, payload || {});
    const response = await fetch(GAS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body)
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch (_) { throw new Error('INVALID_SERVER_RESPONSE'); }
    return data;
}

async function loadAppData() {
    const response = await fetch('assets/data/app-data.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Không tải được app-data.json (HTTP ' + response.status + ')');
    const cfg = await response.json();
    DEFAULT_CATEGORY = cfg.defaultCategory || DEFAULT_CATEGORY;
    PRICE_SHEET_NAMES = Array.isArray(cfg.priceSheetNames) ? cfg.priceSheetNames : [];
    PRICE_FIELD_ALIASES = Array.isArray(cfg.priceFieldAliases) ? cfg.priceFieldAliases : [];
    HEADER_LIKE_IDS = Array.isArray(cfg.headerLikeIds) ? cfg.headerLikeIds : [];
    ROLE_LABELS = cfg.roleLabels || {};
    ROLE_OPTIONS = Array.isArray(cfg.roleOptions) ? cfg.roleOptions : [];
    STATUS_OPTIONS = Array.isArray(cfg.statusOptions) ? cfg.statusOptions : [];
    PERMISSION_LABELS = cfg.permissionLabels || {};
    DEMO_DATA = cfg.demoData || {};
    TAG_CONFIG = cfg.tagConfig || {};
    currentCategory = DEFAULT_CATEGORY;
}

function getStoredToken() {
    try { return String(localStorage.getItem(SESSION_KEY) || ''); }
    catch (_) { return ''; }
}
function storeToken(token) { localStorage.setItem(SESSION_KEY, String(token || '')); }
function clearStoredToken() { localStorage.removeItem(SESSION_KEY); }

function setSessionFromServer(data, token) {
    currentUser = {
        userId: data.userId,
        email: data.email,
        companyId: data.companyId || '',
        name: data.name,
        department: data.department || '',
        role: data.role,
        roles: Array.isArray(data.roles) && data.roles.length ? data.roles : [data.role].filter(Boolean),
        token: token
    };
    currentPermissions = new Set(Array.isArray(data.permissions) ? data.permissions : []);
}

function isAdminUser() { return !!currentUser && Array.isArray(currentUser.roles) && currentUser.roles.includes('admin'); }
function roleDisplayLabel(roles) {
    const list = Array.isArray(roles) ? roles : [roles].filter(Boolean);
    return list.map(r => ROLE_LABELS[r] || r).join(' + ');
}
function hasPermission(key) {
    return !!currentUser && (isAdminUser() || currentPermissions.has(key));
}

async function checkLoginSession() {
    const token = getStoredToken();
    const overlay = document.getElementById('login-overlay');
    if (!token) {
        if (overlay) overlay.style.display = 'flex';
        return;
    }
    try {
        const data = await apiPost('sessionVerify', { token });
        if (!data || !data.success) {
            clearStoredToken();
            currentUser = null;
            currentPermissions = new Set();
            if (overlay) overlay.style.display = 'flex';
            return;
        }
        setSessionFromServer(data, token);
        applyLoggedInUI();
        if (overlay) overlay.style.display = 'none';
        fetchDataFromGoogleSheets();
    } catch (error) {
        console.error('Không xác minh được phiên đăng nhập:', error);
        if (overlay) overlay.style.display = 'flex';
        showAuthError('Không kết nối được máy chủ. Anh/chị kiểm tra mạng rồi thử lại.');
    }
}

function handleUnauthorizedSession() {
    clearStoredToken();
    currentUser = null;
    currentPermissions = new Set();
    showAlert('Phiên đăng nhập đã hết hạn hoặc không hợp lệ - anh/chị đăng nhập lại nhé.', 'info');
    document.getElementById('login-overlay').style.display = 'flex';
}
function isUnauthorizedResponse(data) {
    if (data && data.success === false && (data.error === 'Unauthorized' || data.code === 'UNAUTHORIZED')) {
        handleUnauthorizedSession();
        return true;
    }
    return false;
}

function showAuthError(message) {
    const box = document.getElementById('login-error');
    if (!box) return;
    box.innerText = message;
    box.style.display = 'block';
}
function clearAuthError() {
    const box = document.getElementById('login-error');
    if (box) { box.innerText = ''; box.style.display = 'none'; }
}
function setButtonBusy(button, busy, busyText, normalText) {
    if (!button) return;
    button.disabled = !!busy;
    button.dataset.normalText = button.dataset.normalText || normalText || button.innerText;
    button.innerText = busy ? busyText : (normalText || button.dataset.normalText);
}

function showAlert(message, type, options) {
    type = type || 'info';
    options = options || {};
    const icons = { success: '✓', error: '✕', info: 'ℹ' };
    const iconEl = document.getElementById('friendly-alert-icon');
    const cardEl = document.getElementById('friendly-alert-card');
    const titleEl = document.getElementById('friendly-alert-title');
    const buttonEl = document.getElementById('btn-close-friendly-alert');

    iconEl.className = 'friendly-alert-icon ' + type;
    iconEl.innerText = icons[type] || icons.info;
    cardEl.classList.toggle('important', !!options.important);
    titleEl.innerText = options.title || '';
    buttonEl.innerText = options.buttonText || 'Đã hiểu';
    document.getElementById('friendly-alert-message').innerText = message;
    document.getElementById('friendly-alert-overlay').style.display = 'flex';
}
function closeFriendlyAlert() {
    document.getElementById('friendly-alert-overlay').style.display = 'none';
}
let pendingConfirmCallback = null;
function showConfirm(message, onConfirmCallback) {
    pendingConfirmCallback = onConfirmCallback;
    document.getElementById('friendly-confirm-message').innerText = message;
    document.getElementById('friendly-confirm-overlay').style.display = 'flex';
}
function closeFriendlyConfirm(confirmed) {
    document.getElementById('friendly-confirm-overlay').style.display = 'none';
    const callback = pendingConfirmCallback;
    pendingConfirmCallback = null;
    if (confirmed && typeof callback === 'function') callback();
}

function switchAuthTab(tab) {
    const isLogin = tab === 'login';
    document.getElementById('auth-tab-btn-login').classList.toggle('active', isLogin);
    document.getElementById('auth-tab-btn-register').classList.toggle('active', !isLogin);
    document.getElementById('form-login').style.display = isLogin ? 'grid' : 'none';
    document.getElementById('form-register').style.display = isLogin ? 'none' : 'grid';
    document.getElementById('form-otp').style.display = 'none';
    document.getElementById('auth-subtitle').innerText = isLogin ? 'Đăng nhập để tiếp tục' : 'Đăng ký bằng Email và xác thực OTP';
    clearAuthError();
}

async function loadRegistrationOptions() {
    try {
        const data = await apiPost('registrationOptions', {});
        if (!data || !data.success) return;
        registrationOptions.departments = Array.isArray(data.departments) ? data.departments : [];
        registrationOptions.roles = Array.isArray(data.roles) ? data.roles : [];
        const dept = document.getElementById('regDepartment');
        const role = document.getElementById('regRole');
        if (dept) dept.innerHTML = '<option value="">-- Chọn Phòng ban --</option>' + registrationOptions.departments.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
        if (role) role.innerHTML = '<option value="">-- Chọn Vai trò mong muốn --</option>' + registrationOptions.roles.map(v => `<option value="${escapeHtml(v.value)}">${escapeHtml(v.label)}</option>`).join('');
    } catch (err) {
        console.error('Không tải được lựa chọn đăng ký:', err);
    }
}

async function doLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const btn = document.getElementById('btn-do-login');
    clearAuthError();
    if (!email || !password) return showAuthError('Anh/chị nhập đủ Email và Mật khẩu nhé.');
    if (password.length < 8) return showAuthError('Mật khẩu phải có ít nhất 8 ký tự.');
    setButtonBusy(btn, true, '⏳ Đang đăng nhập...', '🔐 Đăng nhập');
    try {
        const data = await apiPost('login', { email, password });
        if (!data || !data.success) return showAuthError((data && data.error) || 'Đăng nhập không thành công.');
        storeToken(data.token);
        setSessionFromServer(data, data.token);
        document.getElementById('loginPassword').value = '';
        document.getElementById('login-overlay').style.display = 'none';
        applyLoggedInUI();
        fetchDataFromGoogleSheets();
    } catch (err) {
        console.error('Lỗi đăng nhập:', err);
        showAuthError('Không kết nối được máy chủ. Vui lòng thử lại.');
    } finally {
        setButtonBusy(btn, false, '', '🔐 Đăng nhập');
    }
}

async function doRegister() {
    const email = document.getElementById('regEmail').value.trim();
    const companyId = document.getElementById('regCompanyId').value.trim();
    const password = document.getElementById('regPassword').value;
    const name = document.getElementById('regName').value.trim();
    const department = document.getElementById('regDepartment').value;
    const role = document.getElementById('regRole').value;
    const btn = document.getElementById('btn-do-register');
    clearAuthError();
    if (!email || !companyId || !password || !name || !department || !role) return showAuthError('Anh/chị nhập đủ Email, Mã ID công ty, Mật khẩu, Họ tên, Phòng ban và Vai trò mong muốn nhé.');
    if (password.length < 8) return showAuthError('Mật khẩu phải có ít nhất 8 ký tự.');
    setButtonBusy(btn, true, '⏳ Đang gửi OTP...', '✉️ Gửi OTP xác thực');
    try {
        const data = await apiPost('registerStart', { email, companyId, password, name, department, role });
        if (!data || !data.success) return showAuthError((data && data.error) || 'Không thể gửi OTP.');
        pendingRegistrationEmail = data.email || email;
        document.getElementById('form-register').style.display = 'none';
        document.getElementById('form-otp').style.display = 'grid';
        document.getElementById('auth-subtitle').innerText = 'Nhập OTP để xác thực email';
        document.getElementById('otp-hint').innerText = `OTP 6 số đã gửi tới ${pendingRegistrationEmail}. Mã có hiệu lực khoảng ${data.otpMinutes || 10} phút.`;
        document.getElementById('otpCode').focus();
    } catch (err) {
        console.error('Lỗi gửi OTP:', err);
        showAuthError('Không kết nối được máy chủ. Vui lòng thử lại.');
    } finally {
        setButtonBusy(btn, false, '', '✉️ Gửi OTP xác thực');
    }
}

async function verifyRegistrationOtp() {
    const otp = document.getElementById('otpCode').value.trim();
    const btn = document.getElementById('btn-verify-otp');
    clearAuthError();
    if (!pendingRegistrationEmail) return showAuthError('Không tìm thấy đăng ký đang chờ xác thực. Anh/chị đăng ký lại nhé.');
    if (!/^\d{6}$/.test(otp)) return showAuthError('OTP phải gồm đúng 6 chữ số.');
    setButtonBusy(btn, true, '⏳ Đang xác thực...', '✅ Xác thực và tạo tài khoản');
    try {
        const data = await apiPost('registerVerify', { email: pendingRegistrationEmail, otp });
        if (!data || !data.success) return showAuthError((data && data.error) || 'Xác thực OTP không thành công.');
        const verifiedEmail = pendingRegistrationEmail;
        pendingRegistrationEmail = '';
        document.getElementById('otpCode').value = '';

        // User thường phải chờ admin phê duyệt. Chỉ ADMIN_EMAIL được backend active + tạo session ngay.
        if (data.pendingApproval) {
            document.getElementById('loginEmail').value = data.email || verifiedEmail;
            document.getElementById('loginPassword').value = '';
            switchAuthTab('login');
            showAlert(
                'Email đã được xác thực và tài khoản đã được tạo thành công.\n\nTÀI KHOẢN ĐANG CHỜ QUẢN TRỊ VIÊN PHÊ DUYỆT.\n\nHệ thống đã gửi email xác nhận đăng ký. Khi Quản trị viên chấp thuận, anh/chị sẽ nhận thêm email thông báo và có thể đăng nhập vào hệ thống.',
                'success',
                { title: 'Đăng ký thành công', important: true, buttonText: 'OK' }
            );
            return;
        }

        storeToken(data.token);
        setSessionFromServer(data, data.token);
        document.getElementById('login-overlay').style.display = 'none';
        applyLoggedInUI();
        fetchDataFromGoogleSheets();
        showAlert('Xác thực email thành công. Tài khoản Admin đã được kích hoạt và đăng nhập.', 'success');
    } catch (err) {
        console.error('Lỗi xác thực OTP:', err);
        showAuthError('Không kết nối được máy chủ. Vui lòng thử lại.');
    } finally {
        setButtonBusy(btn, false, '', '✅ Xác thực và tạo tài khoản');
    }
}

function backToRegistration() {
    document.getElementById('form-otp').style.display = 'none';
    document.getElementById('form-register').style.display = 'grid';
    document.getElementById('auth-subtitle').innerText = 'Đăng ký bằng Email và xác thực OTP';
    clearAuthError();
}

function doLogout() {
    showConfirm('Anh/chị chắc chắn muốn đăng xuất?', async function () {
        const token = currentUser && currentUser.token;
        try { if (token) await apiPost('logout', { token }); }
        catch (err) { console.error('Không revoke được session lúc logout:', err); }
        clearStoredToken();
        location.reload();
    });
}

function canEditThresholds() { return hasPermission('EDIT_THRESHOLDS'); }

function applyLoggedInUI() {
    if (!currentUser) return;
    document.getElementById('user-welcome-text').innerText = currentUser.name || currentUser.email;
    document.getElementById('user-role-text').innerText = roleDisplayLabel(currentUser.roles);

    const initials = (currentUser.name || currentUser.email || '?').trim().split(/\s+/).map(w => w[0]).slice(-2).join('').toUpperCase();
    document.getElementById('avatar-icon').innerText = initials || '?';
    const userIdEl = document.getElementById('dropdown-userid'); if (userIdEl) userIdEl.innerText = currentUser.userId || '';
    const emailEl = document.getElementById('dropdown-email'); if (emailEl) emailEl.innerText = currentUser.email || '';
    const companyIdEl = document.getElementById('dropdown-companyid'); if (companyIdEl) companyIdEl.innerText = currentUser.companyId || '-';
    document.getElementById('dropdown-fullname').innerText = currentUser.name || currentUser.email;
    const departmentEl = document.getElementById('dropdown-department'); if (departmentEl) departmentEl.innerText = currentUser.department || '-';
    document.getElementById('dropdown-rolebadge').innerText = roleDisplayLabel(currentUser.roles);

    setVisibleByPermission('btn-open-threshold', 'EDIT_THRESHOLDS');
    setVisibleByPermission('btn-open-reorder', 'VIEW_REORDER');
    setVisibleByPermission('btn-open-stagnant', 'VIEW_STAGNANT');
    setVisibleByPermission('btn-export-inventory', 'EXPORT_INVENTORY');
    setVisibleByPermission('btn-export-reorder', 'EXPORT_REORDER');
    const accountsBtn = document.getElementById('btn-open-accounts');
    if (accountsBtn) accountsBtn.style.display = isAdminUser() ? 'inline-flex' : 'none';
    const stagnantBox = document.getElementById('stagnant-config-box');
    if (stagnantBox) stagnantBox.style.display = hasPermission('EDIT_STAGNANT_CONFIG') ? 'block' : 'none';
    const stagnantInput = document.getElementById('stagnantMonthsInput');
    if (stagnantInput) stagnantInput.value = stagnantMonths;
    applyThresholdPermissionUI();
}

function setVisibleByPermission(id, permission) {
    const el = document.getElementById(id);
    if (el) el.style.display = hasPermission(permission) ? '' : 'none';
}

function toggleAccountDropdown() { document.getElementById('account-dropdown').classList.toggle('open'); }
document.addEventListener('click', function (e) {
    const trigger = document.querySelector('.user-account-trigger');
    const dropdown = document.getElementById('account-dropdown');
    if (trigger && dropdown && !trigger.contains(e.target)) dropdown.classList.remove('open');
});

function applyThresholdPermissionUI() {
    const allowed = canEditThresholds();
    const addRow = document.querySelector('.threshold-add-row');
    const manualLink = document.querySelector('#manualThresholdForm')?.previousElementSibling;
    const saveBtn = document.getElementById('btn-save-threshold');
    const noPermNote = document.getElementById('threshold-no-permission-note');
    if (addRow) addRow.style.display = allowed ? '' : 'none';
    if (manualLink) manualLink.style.display = allowed ? '' : 'none';
    if (!allowed && typeof hideManualThresholdForm === 'function') hideManualThresholdForm();
    if (saveBtn) saveBtn.style.display = allowed ? '' : 'none';
    if (noPermNote) noPermNote.style.display = allowed ? 'none' : 'block';
    document.querySelectorAll('.threshold-inline-input').forEach(el => el.disabled = !allowed);
    document.querySelectorAll('#thresholdConfigTableBody .btn-refresh').forEach(el => el.disabled = !allowed);
}

// Dữ liệu demo dự phòng - dùng khi chưa gọi được GAS_API_URL
let DEMO_DATA = {};

let flatInventoryList = [];   // Danh sách gộp phẳng toàn bộ vật tư, mỗi item có thêm field "sheet" (tên danh mục)
let knownCategories = [];     // Danh sách tên danh mục thật (không tính "Giá TB") - dùng cho dropdown khi nhập thủ công mã mới
let departmentList = [];      // Danh sách Phòng ban lấy từ sheet DANH_SACH_PHONG_BAN - dùng cho dropdown ở form đăng ký
let stockHistory = { dates: [], data: {} }; // Lịch sử snapshot tồn kho theo tháng (từ sheet LICH_SU_TON_KHO)
let stagnantMonths = 6;       // Ngưỡng số tháng liên tiếp không đổi số tồn thì coi là "hàng đọng" (admin chỉnh được)

// Sheet "Giá TB" có cấu trúc khác các sheet tồn kho (không có "Tồn cuối", thay bằng "Giá TB") -
// nên cần nhận diện riêng để đổi cách hiển thị bảng cho đúng, giống hệt lúc mở trên Google Sheet.
let PRICE_SHEET_NAMES = [];

function isPriceSheetName(sheetName) {
    const normalized = (sheetName || '').toString().trim().toUpperCase();
    return PRICE_SHEET_NAMES.some(name => name.toUpperCase() === normalized);
}

// Google Apps Script có thể đặt tên field giá theo nhiều kiểu khác nhau (gia, giaTB, price...) -
// hàm này tìm theo danh sách tên khả dĩ, không phân biệt hoa/thường, để không phụ thuộc vào đúng 1 tên field.
let PRICE_FIELD_ALIASES = [];

function getPriceValue(rawItem) {
    if (!rawItem) return undefined;
    const lowerMap = {};
    Object.keys(rawItem).forEach(key => { lowerMap[key.toLowerCase()] = rawItem[key]; });
    for (const alias of PRICE_FIELD_ALIASES) {
        if (lowerMap[alias] !== undefined) return lowerMap[alias];
    }
    return undefined;
}
// Tab mặc định khi vừa mở trang - chọn "CAO SU" vì có ít mã, dựng bảng nhanh hơn nhiều so với
// mở thẳng "Dashboard Tổng" (phải render toàn bộ ~1000+ dòng cùng lúc, gây chậm lúc load lần đầu).
let DEFAULT_CATEGORY = 'CAO SU';
let currentCategory = DEFAULT_CATEGORY;

// Trạng thái sắp xếp bảng - giống hàm Sort trong Excel: bấm vào tiêu đề cột để sắp xếp.
// column: 'name' (Tên Vật Tư) hoặc 'value' (Tồn Kho ở tab thường / Giá TB ở tab Giá TB); null = không sắp xếp, giữ thứ tự gốc.
let sortState = { column: null, direction: 'asc' };

// Trạng thái sort + lọc danh mục RIÊNG cho bảng "Cấu Hình Cảnh Báo Tồn Kho" - tách biệt với sortState của
// bảng tồn kho chính, vì đây là 2 bảng độc lập, không nên ảnh hưởng lẫn nhau.
// column: 'id' (Mã Vật Tư) hoặc 'name' (Tên Vật Tư).
let thresholdSortState = { column: null, direction: 'asc' };
let thresholdCategoryFilter = ''; // rỗng = xem tất cả danh mục

// Lưu lại đúng dữ liệu (đã lọc + đã sort) đang hiển thị trên bảng - dùng khi bấm "Xuất Excel"
let lastRenderedData = [];
let lastRenderedIsPriceView = false;

function toggleSortColumn(column) {
    if (sortState.column === column) {
        sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc'; // bấm lại thì đảo chiều, giống Excel
    } else {
        sortState.column = column;
        sortState.direction = 'asc';
    }
    renderTable();
}

// Icon mũi tên hiển thị trên tiêu đề cột: mờ khi chưa chọn cột đó để sort, đậm + đúng hướng khi đang áp dụng
function getSortIndicatorHtml(column) {
    if (sortState.column !== column) return '<span class="sort-arrow sort-arrow-inactive">↕</span>';
    return sortState.direction === 'asc'
        ? '<span class="sort-arrow sort-arrow-active">▲</span>'
        : '<span class="sort-arrow sort-arrow-active">▼</span>';
}

// ---- CẢNH BÁO TỒN KHO ----
// Không áp ngưỡng chung cho toàn bộ ~1000 mã (mỗi loại vật tư có mức "bình thường" khác nhau, không thể dập khuôn).
// Thay vào đó: chỉ những mã được anh chọn + nhập ngưỡng riêng trong tab "Cảnh báo tồn kho" mới được tô màu cảnh báo.
// thresholdMap: { [mã vật tư]: ngưỡng cảnh báo } - build lại mỗi khi thresholdConfig thay đổi (load xong / thêm / xóa / lưu)
let thresholdConfig = []; // [{ id, name, threshold }] - danh sách hiển thị trong tab cấu hình
let thresholdMap = {};    // tra cứu nhanh khi render bảng chính, key = mã vật tư

// Lọc bảng theo trạng thái cảnh báo: null = không lọc, 'low' = đang bấm "Sắp Hết Hàng", 'out' = đang bấm "Hết Hàng"
// Áp dụng được ở mọi tab (Dashboard Tổng lẫn từng danh mục con) - không dùng được ở tab Giá TB vì không có khái niệm tồn kho.
let stockFilterMode = null;

function toggleStockFilter(mode) {
    const countEl = document.getElementById(mode === 'low' ? 'stat-low' : 'stat-out');
    const count = countEl ? parseInt(countEl.innerText, 10) || 0 : 0;

    if (stockFilterMode === mode) {
        stockFilterMode = null; // bấm lại đúng ô đang lọc thì bỏ lọc
    } else {
        if (count <= 0) return; // bằng 0 thì bấm không có tác dụng gì
        stockFilterMode = mode;
    }
    renderTable();
}

// Bật/tắt hiện thêm 3 cột Tồn Đầu / Nhập / Xuất - dữ liệu này Apps Script đã trả về sẵn (từ sheet gốc)
// nhưng mặc định ẩn đi cho bảng gọn, chỉ hiện khi anh cần xem chi tiết biến động thay vì chỉ mỗi tồn cuối.
// Không áp dụng cho tab Giá TB vì sheet đó không có khái niệm nhập/xuất.
let showMovementColumns = false;

function toggleMovementColumns() {
    showMovementColumns = !showMovementColumns;
    const btn = document.getElementById('btn-toggle-movement');
    if (btn) {
        btn.classList.toggle('active', showMovementColumns);
        btn.innerText = showMovementColumns ? '📊 Ẩn Tồn Đầu/Nhập/Xuất' : '📊 Hiện Tồn Đầu/Nhập/Xuất';
    }
    renderTable();
}

// Bật/tắt biểu đồ "Top tồn kho nhiều nhất" - mặc định TẮT để giữ giao diện gọn gàng như hiện tại,
// chỉ dựng biểu đồ khi anh chủ động bấm xem (đỡ tốn công tính toán không cần thiết lúc chưa cần tới).
let showStockChart = false;

function toggleStockChart() {
    showStockChart = !showStockChart;
    const btn = document.getElementById('btn-toggle-chart');
    if (btn) {
        btn.classList.toggle('active', showStockChart);
        btn.innerText = showStockChart ? '📈 Ẩn Biểu Đồ' : '📈 Xem Biểu Đồ Top Tồn Kho';
    }
    document.getElementById('stock-chart-container').style.display = showStockChart ? 'block' : 'none';
    renderTable(); // vẽ lại ngay dữ liệu hiện tại thay vì đợi lần render kế tiếp
}

// Dựng biểu đồ dạng thanh ngang bằng HTML/CSS thuần (không cần thêm thư viện) - Top 10 mã có Tồn Kho
// cao nhất trong ĐÚNG dữ liệu đang lọc (items đã áp search + hashtag hiện tại của baseFilteredData).
// Chỉ có ý nghĩa trong 1 danh mục cụ thể (đơn vị tính đồng nhất) - ẩn hẳn nút bấm lẫn khu vực này ở
// Dashboard Tổng (đơn vị khác nhau, cộng dồn/so sánh vô nghĩa) và tab Giá TB (không phải tồn kho).
function renderStockChart(items, isPriceView) {
    const toggleBtn = document.getElementById('btn-toggle-chart');
    const container = document.getElementById('stock-chart-container');
    if (!toggleBtn || !container) return;

    const chartApplicable = currentCategory !== 'ALL' && !isPriceView;
    toggleBtn.style.display = chartApplicable ? '' : 'none';

    if (!chartApplicable || !showStockChart) {
        container.style.display = 'none';
        return;
    }
    container.style.display = 'block';

    const top = items.slice().sort((a, b) => b.stock - a.stock).slice(0, 10);
    if (top.length === 0) {
        container.innerHTML = `<div class="panel" style="padding:16px; color:#94a3b8; font-size:13px;">Không có dữ liệu để vẽ biểu đồ.</div>`;
        return;
    }

    const maxStock = Math.max(...top.map(i => i.stock), 1); // tránh chia cho 0 nếu mọi mã đều = 0
    const rowsHtml = top.map(item => {
        const pct = Math.max((item.stock / maxStock) * 100, 2); // tối thiểu 2% để thanh vẫn thấy được kể cả tồn = 0
        return `
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
                <div style="flex:0 0 220px; font-size:12.5px; color:var(--vh-dark); text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(item.id)} - ${escapeHtml(item.name)}">
                    ${escapeHtml(item.name)}
                </div>
                <div style="flex:1; background:#f1f5f9; border-radius:6px; overflow:hidden; height:22px; position:relative;">
                    <div style="width:${pct}%; height:100%; background:linear-gradient(90deg, var(--vh-blue), var(--vh-green)); border-radius:6px;"></div>
                </div>
                <div style="flex:0 0 60px; font-size:13px; font-weight:700; color:var(--vh-dark);">${item.stock.toLocaleString('en-US')}</div>
            </div>
        `;
    }).join('');

    container.innerHTML = `
        <div class="panel" style="padding:18px 20px; margin-bottom:0;">
            <div style="font-size:13.5px; font-weight:700; color:var(--vh-dark); margin-bottom:14px;">
                📈 Top ${top.length} mã tồn kho nhiều nhất ${activeTagsByGroupHasFilter() ? '(theo bộ lọc hashtag đang chọn)' : `- Danh mục: ${escapeHtml(currentCategory)}`}
            </div>
            ${rowsHtml}
        </div>
    `;
}

// Kiểm tra có đang bật ít nhất 1 hashtag lọc nào không - dùng để đổi phụ đề biểu đồ cho đúng ngữ cảnh
function activeTagsByGroupHasFilter() {
    return Object.values(activeTagsByGroup).some(v => !!v);
}



function rebuildThresholdMap() {
    thresholdMap = {};
    thresholdConfig.forEach(t => { thresholdMap[t.id] = t.threshold; });

    syncGhostRows();

    // Cập nhật lại ngay số liệu thống kê (SỐ MÃ ĐANG HIỂN THỊ / SẮP HẾT / HẾT HÀNG) và bảng tồn kho -
    // để anh thấy hiệu lực NGAY sau khi Thêm/Xóa/Sửa ngưỡng, không cần bấm "Làm mới dữ liệu" mới thấy.
    // An toàn gọi ở đây kể cả lúc trang mới tải xong (DOM đã sẵn sàng từ trước khi processData() chạy).
    if (document.getElementById('inventory-table-body')) {
        renderTable();
    }
}

// Đồng bộ "dòng ảo" vào flatInventoryList mỗi khi cấu hình cảnh báo thay đổi - dùng cho mã đã cấu hình
// cảnh báo nhưng bị kế toán ẩn/xóa khỏi Sheet gốc (hoặc mã nhập thủ công chưa từng có trong Sheet).
// Hàm này an toàn gọi lại nhiều lần: luôn dọn sạch dòng ảo cũ trước rồi mới dựng lại từ đầu theo đúng
// thresholdConfig + dữ liệu thật hiện tại, tránh bị sót hoặc bị nhân đôi qua nhiều lần gọi.
function syncGhostRows() {
    flatInventoryList = flatInventoryList.filter(item => !item.isGhost);

    thresholdConfig.forEach(t => {
        // QUAN TRỌNG: loại trừ sheet "Giá TB" khỏi việc kiểm tra "đã tồn tại thật" - vì MỌI mã vật tư đều có
        // 1 dòng giá bên sheet Giá TB (dù có hết hàng ở danh mục thật hay không), nên nếu không loại trừ,
        // hệ thống sẽ luôn nghĩ mã đó "đã có thật" (thấy ở Giá TB) và không bao giờ tạo dòng ảo, dù thực tế
        // mã đó đang ẩn/hết hàng ở đúng danh mục cần cảnh báo (VD Thép Tấm).
        const stillExists = flatInventoryList.some(i => String(i.id) === String(t.id) && !isPriceSheetName(i.sheet));
        if (stillExists) return;
        if (!t.sheet) return; // chưa rõ danh mục (mã cấu hình từ trước khi có bản cập nhật này) -> không đủ dữ liệu để xếp vào tab nào, đành bỏ qua
        flatInventoryList.push({
            sheet: t.sheet,
            id: t.id,
            name: t.name,
            unit: t.unit || '',
            stock: 0,
            tonDau: 0,
            nhap: 0,
            xuat: 0,
            raw: {},
            isGhost: true // đánh dấu đây là dòng suy ra từ cấu hình cảnh báo, không phải dữ liệu thật đọc từ Sheet lúc này
        });
    });
}

function getStockStatus(item) {
    const threshold = thresholdMap[item.id];
    if (threshold === undefined) return 'normal'; // chưa cấu hình cảnh báo cho mã này -> không tô màu gì cả
    if (item.stock <= 0) return 'out';
    if (item.stock <= threshold) return 'low';
    return 'normal';
}

function getStockColorHex(status) {
    if (status === 'out') return '#e74c3c';   // đỏ - hết hàng
    if (status === 'low') return '#f39c12';   // vàng cam - sắp hết
    return 'var(--vh-blue)';                  // xanh dương - bình thường / chưa cấu hình cảnh báo
}

// activeTagsByGroup (dùng cho hashtag lọc nhanh) được khai báo cùng khối code hashtag bên dưới


// Gắn toàn bộ sự kiện của giao diện tại một chỗ để index.html không chứa logic JavaScript inline.
function bindStaticUiEvents() {
    const on = (id, eventName, handler) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener(eventName, handler);
    };

    on('auth-tab-btn-login', 'click', () => switchAuthTab('login'));
    on('auth-tab-btn-register', 'click', () => switchAuthTab('register'));
    on('loginEmail', 'keydown', event => { if (event.key === 'Enter') document.getElementById('loginPassword')?.focus(); });
    on('loginPassword', 'keydown', event => { if (event.key === 'Enter') doLogin(); });
    on('btn-do-login', 'click', doLogin);
    on('regCompanyId', 'keydown', event => { if (event.key === 'Enter') document.getElementById('regPassword')?.focus(); });
    on('regPassword', 'keydown', event => { if (event.key === 'Enter') doRegister(); });
    on('btn-do-register', 'click', doRegister);
    on('otpCode', 'keydown', event => { if (event.key === 'Enter') verifyRegistrationOtp(); });
    on('btn-verify-otp', 'click', verifyRegistrationOtp);
    on('btn-otp-back', 'click', backToRegistration);

    on('user-account-trigger', 'click', toggleAccountDropdown);
    on('account-dropdown', 'click', event => event.stopPropagation());
    on('btn-logout', 'click', doLogout);

    on('btn-open-threshold', 'click', openThresholdConfigPanel);
    on('btn-open-reorder', 'click', openReorderPanel);
    on('btn-open-stagnant', 'click', openStagnantPanel);
    on('btn-open-accounts', 'click', openAccountsPanel);
    on('btn-refresh-data', 'click', refreshData);
    on('initial-dashboard-tab', 'click', function () { filterCategory('ALL', this); });

    on('stat-low-wrap', 'click', () => toggleStockFilter('low'));
    on('stat-out-wrap', 'click', () => toggleStockFilter('out'));
    on('searchInput', 'keyup', renderTable);
    on('btn-toggle-movement', 'click', toggleMovementColumns);
    on('btn-toggle-chart', 'click', toggleStockChart);
    on('btn-export-inventory', 'click', exportToExcel);

    on('btn-close-threshold', 'click', closeThresholdConfigPanel);
    on('thresholdSearchInput', 'input', renderThresholdSuggestions);
    on('btn-add-threshold', 'click', addThresholdItem);
    on('btn-toggle-manual-threshold', 'click', event => {
        event.preventDefault();
        toggleManualThresholdForm();
    });
    on('btn-confirm-manual-threshold', 'click', confirmManualThresholdEntry);
    on('thresholdCategoryFilterSelect', 'change', event => {
        thresholdCategoryFilter = event.target.value;
        renderThresholdConfigTable();
    });
    on('threshold-sort-id', 'click', () => toggleThresholdSortColumn('id'));
    on('threshold-sort-name', 'click', () => toggleThresholdSortColumn('name'));
    on('btn-save-threshold', 'click', saveThresholdConfig);
    on('btn-save-stagnant', 'click', saveStagnantMonths);

    on('btn-close-stagnant', 'click', closeStagnantPanel);
    on('btn-close-accounts', 'click', closeAccountsPanel);
    on('admin-tab-users', 'click', () => switchAdminSection('users'));
    on('admin-tab-permissions', 'click', () => switchAdminSection('permissions'));
    on('accountSearchInput', 'input', renderAccountsTable);
    on('accountRoleFilter', 'change', renderAccountsTable);
    on('accountDepartmentFilter', 'change', renderAccountsTable);
    on('accountSortSelect', 'change', handleAccountSortSelectChange);
    on('accountsTableHead', 'click', toggleAccountHeaderSort);
    on('accountsTableBody', 'change', handleAccountTableChange);
    on('btn-save-role-permissions', 'click', saveRolePermissions);
    on('btn-close-reorder', 'click', closeReorderPanel);
    on('btn-export-reorder', 'click', exportReorderList);

    on('btn-close-friendly-alert', 'click', closeFriendlyAlert);
    on('btn-close-friendly-alert-x', 'click', closeFriendlyAlert);
    on('btn-confirm-cancel', 'click', () => closeFriendlyConfirm(false));
    on('btn-confirm-ok', 'click', () => closeFriendlyConfirm(true));
}

async function initApp() {
    // app.js được đặt ở cuối <body>, nên toàn bộ DOM đã tồn tại khi hàm này chạy.
    // Bind sự kiện NGAY trước mọi thao tác bất đồng bộ để màn hình đăng nhập luôn bấm được,
    // kể cả khi app-data.json tải chậm hoặc lỗi.
    bindStaticUiEvents();

    try {
        await loadAppData();
    } catch (error) {
        console.error('Lỗi nạp app-data.json:', error);
        const errorBox = document.getElementById('login-error');
        if (errorBox) {
            errorBox.innerText = 'Không tải được cấu hình ứng dụng (assets/data/app-data.json). Một số cấu hình phụ có thể chưa sẵn sàng.';
            errorBox.style.display = 'block';
        }
    }

    // Lựa chọn đăng ký (phòng ban + vai trò) là dữ liệu public, tải trước khi login.
    loadRegistrationOptions();
    checkLoginSession();
}


// Đăng ký Service Worker - bật tính năng PWA (cài ra màn hình chính điện thoại, mở lên
// không có thanh địa chỉ, và vẫn hiện được dữ liệu lần tải gần nhất khi mất mạng tạm thời).
// Chỉ hoạt động khi trang được host qua HTTPS thật (VD: GitHub Pages) - mở file trực tiếp từ máy sẽ không có tác dụng.
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        const isLocalDev = ['localhost', '127.0.0.1'].includes(location.hostname);

        if (isLocalDev) {
            // Khi chạy Live Server, Service Worker cũ có thể giữ index/app.js trong cache và làm anh
            // tưởng file mới chưa hoạt động. Dev local không cần PWA nên chủ động gỡ SW khỏi scope localhost.
            navigator.serviceWorker.getRegistrations()
                .then(registrations => Promise.all(registrations.map(registration => registration.unregister())))
                .catch(err => console.warn('Không gỡ được Service Worker cũ trên localhost:', err));
            return;
        }

        navigator.serviceWorker.register('service-worker.js')
            .catch(err => console.error('Không đăng ký được Service Worker (tính năng offline/cài app sẽ không hoạt động):', err));
    });
}


function showLoadingState() {
    const tbody = document.getElementById('inventory-table-body');
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="color:#94a3b8; padding:20px;">Đang tải dữ liệu...</td></tr>`;
}

// Bật/tắt trạng thái "đang làm mới" trên thanh trạng thái - vô hiệu hóa nút để tránh bấm nhiều lần liên tiếp
function setSyncing(isSyncing) {
    const btn = document.getElementById('btn-refresh-data');
    const text = document.getElementById('sync-status-text');
    if (btn) {
        btn.disabled = isSyncing;
        btn.innerText = isSyncing ? '🔄 Đang làm mới...' : '🔄 Làm mới dữ liệu';
    }
    if (isSyncing && text) text.innerText = '🕒 Đang tải dữ liệu...';
}

// Cập nhật dòng chữ "Cập nhật lúc..." - đây là thời điểm TRANG WEB lấy dữ liệu thành công gần nhất
// (không phải giờ anh sửa số liệu trong Google Sheet - vì Apps Script không trả kèm thông tin đó).
function updateSyncStatusText(isDemo) {
    const text = document.getElementById('sync-status-text');
    if (!text) return;
    const now = new Date();
    const timeStr = now.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
    text.innerText = isDemo
        ? `⚠️ Không kết nối được dữ liệu thật lúc ${timeStr} - đang xem dữ liệu demo`
        : `🕒 Dữ liệu được tải lúc: ${timeStr}`;
}

// Gọi API lấy dữ liệu từ Google Sheets Database (qua Apps Script) - PHẢI gửi kèm token đăng nhập,
// Apps Script mới trả dữ liệu thật (xem huong-dan-sua-bao-mat-api.md). Nếu chưa đăng nhập (chưa có
// currentUser.token) thì không gọi luôn, tránh lộ việc URL vẫn nhận request dù thiếu token.
function fetchDataFromGoogleSheets() {
    if (!currentUser || !currentUser.token) return;
    showLoadingState();
    setSyncing(true);
    fetch(GAS_API_URL + '?token=' + encodeURIComponent(currentUser.token))
        .then(response => {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
        })
        .then(data => {
            // Token hết hạn/không hợp lệ -> Apps Script trả { success:false, error:'Unauthorized' } thay
            // vì dữ liệu tồn kho thật. Xử lý riêng, KHÔNG rơi về dữ liệu demo (dễ gây hiểu lầm mất mạng).
            if (isUnauthorizedResponse(data)) return;
            processData(data);
            toggleDemoBanner(false);
            updateSyncStatusText(false);
        })
        .catch(error => {
            console.error("Lỗi khi tải dữ liệu từ Google Sheets, dùng dữ liệu demo thay thế:", error);
            processData(DEMO_DATA);
            toggleDemoBanner(true);
            updateSyncStatusText(true);
        })
        .finally(() => {
            setSyncing(false);
        });
}

// Hàm gọi khi bấm nút "Làm mới dữ liệu" - tải lại dữ liệu mới nhất từ Google Sheet mà không cần F5 cả trang.
// Tab/hashtag/tìm kiếm/sắp xếp đang chọn sẽ được giữ nguyên (renderCategoryTabs tự nhận diện lại đúng tab cũ).
function refreshData() {
    fetchDataFromGoogleSheets();
}

function toggleDemoBanner(isDemo) {
    const banner = document.getElementById('demo-banner');
    if (banner) banner.style.display = isDemo ? 'block' : 'none';
}

// Những giá trị id coi là "dòng tiêu đề bị lẫn vào dữ liệu" - cần loại bỏ, không phải vật tư thật.
let HEADER_LIKE_IDS = [];

function isHeaderRow(item) {
    const id = (item.id || '').toString().trim().toLowerCase();
    const name = (item.name || '').toString().trim().toLowerCase();
    if (!id && !name) return true; // dòng trống hoàn toàn
    if (HEADER_LIKE_IDS.includes(id)) return true;
    if (id === 'mã vật tư' || name === 'tên vật tư') return true;
    return false;
}

// Chuyển dữ liệu thô { sheetName: [...] } thành danh sách phẳng để dễ lọc/hiển thị
function processData(data) {
    if (data && data._session && currentUser) {
        const token = currentUser.token;
        setSessionFromServer(data._session, token);
        applyLoggedInUI();
    }
    flatInventoryList = [];
    // Loại trừ mọi "key phụ" (metadata) mà Apps Script gắn thêm vào - chúng bắt đầu bằng dấu gạch dưới
    // (_thresholds, _departments, _stockHistory, _stagnantMonths...) và KHÔNG phải mảng danh mục tồn kho.
    // Nếu không loại, vòng lặp bên dưới sẽ gọi .forEach() lên chúng và nổ lỗi "items.forEach is not a function".
    const realSheetNames = Object.keys(data).filter(key => !key.startsWith('_'));

    realSheetNames.forEach(sheetName => {
        const items = data[sheetName] || [];
        items.forEach(item => {
            if (isHeaderRow(item)) return; // bỏ qua dòng tiêu đề lẫn vào dữ liệu

            flatInventoryList.push({
                sheet: sheetName,
                id: item.id,
                name: item.name,
                unit: item.unit,
                stock: parseFloat(item.tonCuoi) || 0,
                tonDau: parseFloat(item.tonDau) || 0,
                nhap: parseFloat(item.nhap) || 0,
                xuat: parseFloat(item.xuat) || 0,
                raw: item // giữ lại dữ liệu gốc của dòng, dùng khi hiển thị sheet Giá TB (khác cấu trúc cột)
            });
        });
    });

    // Nạp cấu hình cảnh báo tồn kho (nếu Apps Script có trả về) - ghép thêm tên vật tư để hiển thị đẹp trong tab cấu hình.
    // Hỗ trợ cả 2 định dạng: cũ (chỉ là số ngưỡng) và mới (object có kèm tên/danh mục/đvt đã lưu sẵn từ lúc thêm mã) -
    // để không vỡ nếu Apps Script bên server chưa kịp cập nhật theo định dạng mới.
    const thresholdsFromServer = data._thresholds || {};
    thresholdConfig = Object.keys(thresholdsFromServer).map(id => {
        const raw = thresholdsFromServer[id];
        const isObjectFormat = raw !== null && typeof raw === 'object';
        const threshold = Number(isObjectFormat ? raw.threshold : raw) || 0;
        // QUAN TRỌNG: loại trừ sheet "Giá TB" khỏi việc tìm "dữ liệu thật" - lý do y hệt syncGhostRows() bên dưới:
        // mọi mã đều có 1 dòng giá bên Giá TB, nếu không loại trừ thì mã đang hết hàng/ẩn ở danh mục thật
        // (VD Thép Tấm) sẽ luôn bị "tìm thấy" nhầm qua dòng Giá TB, khiến danh mục anh đã cấu hình bị Giá TB
        // ghi đè lại mỗi lần tải dữ liệu, dù anh không hề đổi gì.
        const matchedItem = flatInventoryList.find(i => String(i.id) === String(id) && !isPriceSheetName(i.sheet));

        // Ưu tiên lấy tên/danh mục/đvt từ dữ liệu tồn kho hiện tại (luôn là dữ liệu mới nhất) -
        // chỉ dùng lại thông tin đã lưu trong cấu hình khi mã đó KHÔNG còn thấy trong tồn kho nữa
        // (trường hợp kế toán đã ẩn dòng = 0 khỏi Sheet gốc).
        return {
            id: id,
            name: matchedItem ? matchedItem.name : (isObjectFormat && raw.name) || '(mã đã ẩn khỏi bảng tồn kho - có thể do hết hàng)',
            sheet: matchedItem ? matchedItem.sheet : (isObjectFormat ? raw.sheet : null) || null,
            unit: matchedItem ? matchedItem.unit : (isObjectFormat ? raw.unit : '') || '',
            threshold: threshold
        };
    });
    rebuildThresholdMap(); // hàm này giờ tự gọi kèm syncGhostRows() để dựng "dòng ảo" luôn, không cần lặp code ở đây nữa

    // Lưu lại danh sách danh mục thật (loại "Giá TB" ra - sheet đó không có khái niệm tồn kho) để dùng
    // cho dropdown "Danh mục" khi anh cần nhập thủ công 1 mã hoàn toàn chưa có trong dữ liệu tải về.
    knownCategories = realSheetNames.filter(name => !isPriceSheetName(name));

    // Danh sách Phòng ban lấy từ sheet DANH_SACH_PHONG_BAN (Apps Script trả về qua _departments) -
    // dùng để dựng dropdown ở form đăng ký, đồng bộ đúng danh sách anh đang quản lý bên Sheet.
    if (Array.isArray(data._departments)) departmentList = data._departments;
    else if (Array.isArray(registrationOptions.departments)) departmentList = registrationOptions.departments;
    renderDepartmentOptions();

    // Lịch sử snapshot tồn kho + ngưỡng tháng hàng đọng (dùng cho tab "Hàng tồn đọng")
    stockHistory = data._stockHistory || { dates: [], data: {} };
    stagnantMonths = Number(data._stagnantMonths) || 6;

    renderCategoryTabs(realSheetNames);

    // Cập nhật lại chấm đỏ chờ duyệt sau mỗi lần làm mới dữ liệu (chỉ chạy nếu admin đang đăng nhập)
    if (currentUser && isAdminUser()) refreshPendingBadge();
}

// Dựng lại danh sách lựa chọn Phòng ban trong form đăng ký theo đúng dữ liệu mới nhất tải về
function renderDepartmentOptions() {
    const select = document.getElementById('regDepartment');
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = '<option value="">-- Chọn Phòng ban --</option>' +
        departmentList.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    if (departmentList.includes(currentVal)) select.value = currentVal;
}

// Sinh các nút tab danh mục dựa trên tên sheet thật có trong dữ liệu
function renderCategoryTabs(sheetNames) {
    const container = document.getElementById('nav-tabs-container');
    container.innerHTML = '';

    const buttonsByName = {};

    if (hasPermission('VIEW_DASHBOARD')) {
        const allBtn = document.createElement('button');
        allBtn.className = 'nav-tab-btn';
        allBtn.innerText = '📊 Dashboard Tổng';
        allBtn.onclick = function () { filterCategory('ALL', allBtn); };
        container.appendChild(allBtn);
        buttonsByName['ALL'] = allBtn;
    }

    sheetNames.forEach(name => {
        const allowed = isPriceSheetName(name) ? hasPermission('VIEW_PRICE') : hasPermission('VIEW_INVENTORY');
        if (!allowed) return;
        const btn = document.createElement('button');
        btn.className = 'nav-tab-btn';
        btn.innerText = name;
        btn.onclick = function () { filterCategory(name, btn); };
        container.appendChild(btn);
        buttonsByName[name] = btn;
    });

    // Ưu tiên giữ nguyên tab đang xem (VD sau khi bấm "Làm mới dữ liệu" thì không bị nhảy về tab khác).
    // Nếu tab đó không còn tồn tại nữa (VD đổi tên sheet) thì fallback về CAO SU, rồi mới đến Dashboard Tổng.
    const firstAvailable = Object.keys(buttonsByName)[0];
    const targetCategory = buttonsByName[currentCategory]
        ? currentCategory
        : (buttonsByName[DEFAULT_CATEGORY] ? DEFAULT_CATEGORY : (buttonsByName['ALL'] ? 'ALL' : firstAvailable));

    if (targetCategory) filterCategory(targetCategory, buttonsByName[targetCategory]);
    else {
        currentCategory = 'ALL';
        renderTable();
    }
}

function filterCategory(category, btnElement) {
    currentCategory = category;
    activeTagsByGroup = {}; // đổi tab thì bỏ toàn bộ hashtag đang lọc của tab cũ
    stockFilterMode = null; // đổi tab thì cũng bỏ luôn bộ lọc cảnh báo tồn kho của tab cũ

    document.querySelectorAll('.nav-tab-btn').forEach(b => b.classList.remove('active'));
    if (btnElement) btnElement.classList.add('active');

    renderTagFilters();
    renderTable();
}

// ---- HASHTAG LỌC NHANH - CẤU HÌNH RIÊNG CHO TỪNG DANH MỤC ----
// Mỗi danh mục có cách đặt tên vật tư khác nhau nên không thể dùng chung 1 kiểu hashtag.
// Có 2 kiểu group:
//   - "keywords": liệt kê sẵn các giá trị cụ thể, khớp khi tên vật tư chứa đúng cụm từ đó
//     (dùng khi biết chắc quy ước đặt tên - VD: chủng loại/mác cao su theo anh cung cấp)
//   - "auto": tự "đọc" tên vật tư để tìm mẫu lặp lại nhiều lần (mác thép, chiều dày, cấp bền bulong...)
//     rồi tự sinh hashtag - dùng khi không có danh sách cố định trước.
//
// LƯU Ý: Cao Su, VTTH, Tấm Trượt, Vật Tư Khác và Thép Khác dùng đúng theo yêu cầu anh cung cấp.
// Thép Tấm giữ nguyên như cũ (đã xác nhận ổn).
// Riêng Bulong vẫn là em tạm suy đoán từ khóa điển hình của ngành -
// anh xem thử có khớp với cách đặt tên thật trong file không, sai chỗ nào anh báo em chỉnh lại.
let TAG_CONFIG = {};

// Chuỗi ký tự đặc biệt trong regex cần escape trước khi nhét giá trị động vào new RegExp(...)
function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Tự "đọc" tên vật tư để tìm các giá trị lặp lại nhiều lần, dùng cho group kiểu "auto-*"
function extractAutoValues(items, type) {
    const counts = {};

    items.forEach(item => {
        const name = String(item.name || '').toUpperCase();
        let matches = [];

        if (type === 'auto-grade') {
            // Mác thép: cụm chữ+số kiểu A36, SS400, Q345B, A572, Q355...
            // Dùng (?!\d) thay vì \b ở cuối - phòng trường hợp tên viết dính liền số phía sau
            // (VD "Q355B16X2000X6000" không có khoảng trắng) sẽ bị \b bỏ sót y như lỗi M16 gặp trước đó.
            matches = name.match(/\b[A-Z]{1,4}\d{2,4}[A-Z]?(?!\d)/g) || [];
            // Loại bỏ dạng "D700", "D250"... - đây là ký hiệu ĐƯỜNG KÍNH của tấm tròn (VD "Q355 tròn
            // D700X115"), không phải mác thép, nếu không loại sẽ bị lẫn vào hashtag Mác thép sai chỗ.
            matches = matches.filter(m => !/^D\d+$/.test(m));
        } else if (type === 'auto-thickness') {
            // Chiều dày: có 2 dạng khác nhau tuỳ tấm vuông/chữ nhật hay tấm tròn -
            // - Tấm chữ nhật "dàyXrộngXdài" (VD "55X2000X6000") -> dày là số ĐẦU TIÊN.
            // - Tấm tròn "D<đường kính>X<dày>" (VD "D700X115") -> dày là số THỨ HAI (sau D...X),
            //   KHÔNG PHẢI đường kính - nếu dùng chung công thức lấy số đầu tiên sẽ nhầm đường kính
            //   (700) thành chiều dày, còn dày thật (115) thì bị bỏ sót hoàn toàn.
            const roundMatch = name.match(/\bD\d{2,4}X(\d+(?:\.\d+)?)/);
            if (roundMatch) {
                matches = [roundMatch[1]];
            } else {
                const dimMatch = name.match(/(\d+(?:\.\d+)?)\s*X\s*\d+/);
                if (dimMatch) matches = [dimMatch[1]];
            }
        } else if (type === 'auto-bolt-strength') {
            // Cấp bền bulong dạng "8.8", "10.9", "12.9"... - dùng (?!\d) thay vì \b ở cuối,
            // phòng trường hợp tên viết dính liền chữ/số phía sau (VD "8.8T", "10.9-M16") mà \b không nhận ra ranh giới.
            matches = name.match(/\b\d{1,2}\.\d(?!\d)/g) || [];
        } else if (type === 'auto-bolt-diameter') {
            // Đường kính ren dạng "M12", "M16", "M20"... - dùng (?!\d) thay vì \b ở cuối, vì tên vật tư
            // thường viết liền kiểu "M16X40" (không có khoảng trắng trước X) - \b không nhận ra ranh giới
            // giữa số và chữ X (cả 2 đều là ký tự "chữ/số" nên không phải ranh giới thật), khiến rất nhiều
            // mã có tên dạng này bị bỏ sót hoàn toàn khỏi hashtag.
            matches = name.match(/\bM\d{1,3}(?!\d)/g) || [];
        } else if (type === 'auto-diameter-d') {
            // Đường kính dạng "D250", "D260" - đứng ngay trước 1 số khác có "X" ở giữa (VD "D250X108X7")
            // Dùng lookahead (?=X) thay vì \b ở cuối, vì sau số vẫn dính liền chữ X, không có khoảng trắng/ký tự phân cách.
            matches = name.match(/\bD\d{2,4}(?=X)/g) || [];
        } else if (type === 'auto-v-size') {
            // Size thép hình (V40, V45, V50, H125, H150...) - tự nhận diện bất kỳ số nào đi ngay sau
            // chữ V hoặc H trong tên (2 tiền tố phổ biến của thép hình/thép hộp chữ H theo dữ liệu thực tế),
            // không giới hạn cứng theo danh sách liệt kê nữa. Không phân biệt hoa/thường vì "name" đã được
            // chuyển toàn bộ sang chữ hoa ở đầu hàm.
            matches = name.match(/\b[VH]\d{2,4}(?!\d)/g) || [];
        } else if (type === 'auto-first-word') {
            // Chữ/từ đầu tiên của tên vật tư (VD "Áo đồng phục..." -> "Áo", "Bàn ren M12" -> "Bàn") -
            // giữ nguyên chữ hoa/thường gốc để hiển thị đẹp, không ép toàn bộ thành chữ in hoa.
            const rawFirstWord = String(item.name || '').trim().match(/^\S+/);
            if (rawFirstWord) matches = [rawFirstWord[0]];
        }

        matches.forEach(m => { counts[m] = (counts[m] || 0) + 1; });
    });

    // Chỉ giữ giá trị xuất hiện từ 2 mã trở lên, tránh hashtag lẻ tẻ không có tác dụng lọc.
    // Riêng "chữ đầu", "đường kính D", "đường kính bulong M", "size V/H" và "mác thép" thì giữ từ
    // 1 mã trở lên - vì nhiều mác/kích thước chỉ xuất hiện đúng 1 mã trong cả sheet (VD mới nhập 1
    // sản phẩm loại đó), lọc từ 2 trở lên sẽ làm mất hẳn hashtag dù mã đó có thật trong dữ liệu.
    const minCount = (type === 'auto-first-word' || type === 'auto-diameter-d' || type === 'auto-bolt-diameter' || type === 'auto-v-size' || type === 'auto-grade') ? 1 : 2;
    let entries = Object.entries(counts).filter(([, count]) => count >= minCount);

    if (type === 'auto-thickness') {
        // Không cắt bớt (trước đây .slice(0,12) khiến các chiều dày lớn hơn 25 không bao giờ lọt vào danh sách
        // dù thực tế có mã khớp) - số chiều dày thực tế của thép tấm không nhiều nên không cần giới hạn.
        entries = entries.sort((a, b) => Number(a[0]) - Number(b[0]));
    } else if (type === 'auto-bolt-strength') {
        entries = entries.sort((a, b) => Number(a[0]) - Number(b[0])).slice(0, 8);
    } else if (type === 'auto-bolt-diameter' || type === 'auto-v-size') {
        // Nới giới hạn từ 15 lên 40 - bulong/thép hình thường có nhiều kích thước khác nhau,
        // giới hạn thấp trước đây cắt mất các kích thước lớn.
        entries = entries.sort((a, b) => Number(a[0].replace(/\D/g, '')) - Number(b[0].replace(/\D/g, ''))).slice(0, 40);
    } else if (type === 'auto-diameter-d') {
        entries = entries.sort((a, b) => Number(a[0].replace(/\D/g, '')) - Number(b[0].replace(/\D/g, ''))).slice(0, 40);
    } else if (type === 'auto-grade') {
        // Sắp theo alphabet thay vì theo tần suất xuất hiện nhiều/ít - trước đây "top 10 theo tần suất"
        // khiến mác nào chỉ có 1-2 mã (VD S45C, Q345 mới nhập) dễ bị đá văng ra ngoài dù có thật trong dữ liệu.
        entries = entries.sort((a, b) => a[0].localeCompare(b[0], 'vi')).slice(0, 30);
    } else if (type === 'auto-first-word') {
        entries = entries.sort((a, b) => a[0].localeCompare(b[0], 'vi')).slice(0, 30);
    } else {
        entries = entries.sort((a, b) => b[1] - a[1]).slice(0, 10);
    }

    return entries.map(([val]) => val);
}

// Kiểm tra 1 vật tư có khớp với 1 giá trị hashtag cụ thể của 1 group hay không
function itemMatchesGroupValue(item, group, value) {
    const name = String(item.name || '').toUpperCase();

    if (group.type === 'keywords') {
        // Khớp dạng chứa cụm từ - dùng cho cả cụm nhiều từ ("Đĩa cao su") lẫn mã ngắn ("NR", "EPDM")
        return name.includes(value.toUpperCase());
    }
    if (group.type === 'auto-grade' || group.type === 'auto-bolt-strength') {
        // Dùng (?!\d) thay vì \b ở cuối - đồng bộ với cách trích xuất, tránh bỏ sót khi tên viết dính liền số phía sau
        return new RegExp('\\b' + escapeRegExp(value) + '(?!\\d)').test(name);
    }
    if (group.type === 'auto-bolt-diameter' || group.type === 'auto-v-size') {
        // Dùng (?!\d) giống lúc trích xuất - tránh lỗi \b không nhận ra ranh giới khi tên viết liền
        // kiểu "M16X40" hoặc "V40X40X4" (không có khoảng trắng trước ký tự tiếp theo).
        return new RegExp('\\b' + escapeRegExp(value) + '(?!\\d)').test(name);
    }
    if (group.type === 'auto-diameter-d') {
        // Dùng lookahead (?=X) giống lúc trích xuất, vì sau số dính liền "X" chứ không có khoảng trắng
        return new RegExp('\\b' + escapeRegExp(value) + '(?=X)').test(name);
    }
    if (group.type === 'auto-thickness') {
        const dimMatch = name.match(/(\d+(?:\.\d+)?)\s*X\s*\d+/);
        return dimMatch && dimMatch[1] === value;
    }
    if (group.type === 'auto-first-word') {
        const rawFirstWord = String(item.name || '').trim().match(/^\S+/);
        return !!rawFirstWord && rawFirstWord[0].toUpperCase() === value.toUpperCase();
    }
    return false;
}

// Lấy danh sách giá trị hashtag của 1 group (đã lọc theo dữ liệu thực tế đang có trong danh mục)
function getGroupValues(items, group) {
    if (group.type === 'keywords') {
        // Chỉ hiện hashtag nào thực sự có ít nhất 1 mã khớp - tránh hiện hashtag chết, không lọc ra gì
        return group.values.filter(v => items.some(item => itemMatchesGroupValue(item, group, v)));
    }

    let values = extractAutoValues(items, group.type);

    // Một số group có thêm "extraValues" - các giá trị anh muốn luôn thấy hashtag, kể cả khi hiện tại
    // chưa có mã nào khớp trong dữ liệu đang hiển thị (VD mã đó đang bị kế toán ẩn dòng vì tồn = 0).
    // Hashtag vẫn hiện nhưng sẽ bị làm mờ/không bấm được (xem buildTagPill) cho tới khi có mã khớp thật.
    if (group.extraValues && group.extraValues.length) {
        const merged = new Set([...values, ...group.extraValues]);
        values = Array.from(merged).sort((a, b) => Number(a) - Number(b));
    }

    return values;
}

let activeTagsByGroup = {}; // { [groupKey]: giá trị đang chọn }, reset mỗi khi đổi tab danh mục

function renderTagFilters() {
    const container = document.getElementById('tag-filters-container');
    container.innerHTML = '';

    const config = TAG_CONFIG[currentCategory];
    if (!config) return; // danh mục chưa có cấu hình hashtag (VD: Dashboard Tổng, Vật Tư Khác) -> bỏ qua

    const itemsInCategory = flatInventoryList.filter(i => i.sheet === currentCategory);

    config.groups.forEach(group => {
        const values = getGroupValues(itemsInCategory, group);
        if (values.length === 0) return;

        // Mỗi group hashtag nằm trên 1 dòng riêng biệt, không dồn chung với group khác
        const row = document.createElement('div');
        row.className = 'tag-group-row';

        const label = document.createElement('span');
        label.className = 'tag-group-label';
        label.innerText = group.label;
        row.appendChild(label);

        values.forEach(value => {
            // Đếm số mã còn thỏa nếu chọn giá trị này, với điều kiện các group khác đang chọn vẫn giữ nguyên
            const count = itemsInCategory.filter(item => {
                const matchesThisValue = itemMatchesGroupValue(item, group, value);
                const matchesOtherActiveGroups = config.groups.every(g => {
                    if (g.key === group.key) return true;
                    const activeVal = activeTagsByGroup[g.key];
                    return !activeVal || itemMatchesGroupValue(item, g, activeVal);
                });
                return matchesThisValue && matchesOtherActiveGroups;
            }).length;

            row.appendChild(buildTagPill(group, value, count));
        });

        container.appendChild(row);
    });
}

function buildTagPill(group, value, matchCount) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'tag-pill';
    pill.innerText = value;

    const isActive = activeTagsByGroup[group.key] === value;
    if (isActive) pill.classList.add('active');

    // Đang chọn rồi thì luôn cho bấm để bỏ chọn, dù tổ hợp hiện tại có ra 0 kết quả hay không.
    // Chưa chọn mà tổ hợp với lựa chọn kia không ra mã nào -> làm mờ, không cho bấm (giống chọn size hết hàng bên Shopee).
    const isDisabled = !isActive && matchCount === 0;
    pill.disabled = isDisabled;

    pill.onclick = function () {
        activeTagsByGroup[group.key] = (activeTagsByGroup[group.key] === value) ? null : value; // bấm lại thì bỏ chọn
        renderTagFilters();
        renderTable();
    };
    return pill;
}

function itemMatchesActiveTag(item) {
    const config = TAG_CONFIG[item.sheet];
    if (!config) return true; // danh mục không có hashtag -> không lọc gì thêm

    return config.groups.every(group => {
        const activeVal = activeTagsByGroup[group.key];
        return !activeVal || itemMatchesGroupValue(item, group, activeVal);
    });
}

// Chuyển ký tự đặc biệt (<, >, &, ", ') thành entity HTML - tránh vỡ layout bảng
// khi tên/mã vật tư nhập tay lỡ có ký tự dạng thẻ HTML (VD: "Ống thép <phi 60>")
function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Dựng lại header bảng tùy theo đang xem tab tồn kho hay tab Giá TB - cho giống hệt cấu trúc cột bên Google Sheet
function renderTableHeader(isPriceView) {
    const thead = document.getElementById('table-head');
    if (!thead) return;

    // Nút "Hiện Tồn Đầu/Nhập/Xuất" không có ý nghĩa ở tab Giá TB (không có khái niệm nhập/xuất) -> ẩn luôn nút đi
    const toggleBtn = document.getElementById('btn-toggle-movement');
    if (toggleBtn) toggleBtn.style.display = isPriceView ? 'none' : '';

    const showMovement = showMovementColumns && !isPriceView;
    const movementHeaderCells = showMovement
        ? `<th class="text-right">Tồn Đầu</th><th class="text-right">Nhập</th><th class="text-right">Xuất</th>`
        : '';

    // Cột "Danh Mục" chỉ CÓ Ý NGHĨA khi xem Dashboard Tổng (mỗi dòng có thể thuộc danh mục khác nhau) -
    // khi đang xem đúng 1 danh mục cụ thể (VD tab THÉP TẤM), mọi dòng đều cùng 1 danh mục với tiêu đề panel
    // phía trên rồi, hiện lại cột này là thừa, nhất là trên điện thoại màn hình hẹp.
    const showCategoryColumn = currentCategory === 'ALL';
    const categoryHeaderCell = showCategoryColumn ? `<th class="text-left">Danh Mục</th>` : '';

    thead.innerHTML = isPriceView
        ? `<tr>
            <th>Stt</th>
            <th class="text-left" style="width:110px; max-width:110px;">Mã Vật Tư</th>
            <th class="text-left sortable" onclick="toggleSortColumn('name')">Tên Vật Tư ${getSortIndicatorHtml('name')}</th>
            <th>ĐVT</th>
            <th class="text-right sortable" onclick="toggleSortColumn('value')">Giá TB ${getSortIndicatorHtml('value')}</th>
        </tr>`
        : `<tr>
            <th class="text-left" style="width:110px; max-width:110px;">Mã Vật Tư</th>
            <th class="text-left sortable" onclick="toggleSortColumn('name')">Tên Vật Tư ${getSortIndicatorHtml('name')}</th>
            <th>ĐVT</th>
            ${movementHeaderCells}
            <th class="text-right sortable" onclick="toggleSortColumn('value')">Tồn Kho ${getSortIndicatorHtml('value')}</th>
            ${categoryHeaderCell}
        </tr>`;
}

function renderTable() {
    const searchTerm = (document.getElementById('searchInput').value || '').toLowerCase();
    const tbody = document.getElementById('inventory-table-body');

    const isPriceView = currentCategory !== 'ALL' && isPriceSheetName(currentCategory);

    // Dữ liệu dùng để ĐẾM cho 2 ô "Sắp Hết Hàng"/"Hết Hàng" - KHÔNG áp bộ lọc cảnh báo vào đây,
    // để 2 ô luôn hiện đúng tổng số thật theo tab/tìm kiếm/hashtag hiện tại, dù đang bấm lọc ô nào.
    const baseFilteredData = flatInventoryList.filter(item => {
        const id = String(item.id == null ? '' : item.id).toLowerCase();
        const name = String(item.name == null ? '' : item.name).toLowerCase();
        const matchesSearch = id.includes(searchTerm) || name.includes(searchTerm);
        // Dashboard Tổng (ALL) gộp mọi danh mục tồn kho thật lại - nhưng Giá TB không phải tồn kho, chỉ là
        // bảng giá tham khảo (không có cột Tồn cuối thật, mặc định về 0 khi đọc), nên phải loại hẳn ra khỏi
        // Dashboard Tổng, tránh nó bị tính nhầm vào "Hết Hàng" dù không hề liên quan gì đến tồn kho.
        const matchesCategory = currentCategory === 'ALL'
            ? !isPriceSheetName(item.sheet)
            : item.sheet === currentCategory;
        const matchesTag = itemMatchesActiveTag(item);
        return matchesSearch && matchesCategory && matchesTag;
    });

    // Dữ liệu dùng để HIỂN THỊ BẢNG - có áp thêm bộ lọc cảnh báo nếu đang bật
    const filteredData = baseFilteredData.filter(item => {
        return !stockFilterMode || (!isPriceView && getStockStatus(item) === stockFilterMode);
    });

    renderTableHeader(isPriceView);

    // Hàm lấy "giá trị số" của 1 dòng để so sánh khi sort cột value - tùy tab mà cột đó là Tồn Kho hay Giá TB
    const getSortValueNumber = isPriceView
        ? (item => parseFloat(getPriceValue(item.raw)) || 0)
        : (item => item.stock);

    if (sortState.column) {
        const dir = sortState.direction === 'asc' ? 1 : -1;
        filteredData.sort((a, b) => {
            if (sortState.column === 'name') {
                // So sánh kiểu tiếng Việt, có nhận diện số trong chuỗi (giống Sort A-Z của Excel)
                return String(a.name || '').localeCompare(String(b.name || ''), 'vi', { numeric: true }) * dir;
            }
            if (sortState.column === 'value') {
                return (getSortValueNumber(a) - getSortValueNumber(b)) * dir;
            }
            return 0;
        });
    }

    const showMovement = showMovementColumns && !isPriceView;
    const showCategoryColumn = currentCategory === 'ALL';
    const totalColumns = isPriceView ? 5 : (4 + (showMovement ? 3 : 0) + (showCategoryColumn ? 1 : 0));

    if (filteredData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${totalColumns}" style="color:#94a3b8; padding:20px;">Không tìm thấy vật tư phù hợp.</td></tr>`;
        document.getElementById('stat-total').innerText = 0;
        updateStockWarningStats(baseFilteredData, isPriceView);
        lastRenderedData = [];
        lastRenderedIsPriceView = isPriceView;
        return;
    }

    if (isPriceView) {
        // Bảng "Giá TB": cột Stt đánh số theo thứ tự đang hiển thị, cột cuối là giá thay vì tồn kho/danh mục
        const rowsHtml = filteredData.map((item, index) => {
            const priceRaw = getPriceValue(item.raw);
            const priceNum = parseFloat(priceRaw);
            const priceDisplay = isNaN(priceNum) ? escapeHtml(priceRaw) : priceNum.toLocaleString('en-US');

            return `
                <tr>
                    <td>${index + 1}</td>
                    <td class="text-left font-bold">${escapeHtml(item.id)}</td>
                    <td class="text-left">${escapeHtml(item.name)}</td>
                    <td>${escapeHtml(item.unit)}</td>
                    <td class="text-right" style="font-weight:bold; font-size:15px; color:var(--vh-blue);">${priceDisplay}</td>
                </tr>
            `;
        });
        // Gán 1 lần duy nhất - trình duyệt chỉ parse/dựng DOM 1 lần thay vì mỗi lần thêm 1 dòng
        // (dùng += trong vòng lặp bắt trình duyệt đọc lại + parse lại toàn bộ bảng đã có sau mỗi dòng,
        // càng nhiều dòng càng chậm dần - đây là nguyên nhân chính gây giật/chậm khi load nhiều mã).
        tbody.innerHTML = rowsHtml.join('');
    } else {
        const rowsHtml = filteredData.map(item => {
            const status = getStockStatus(item);
            const stockColor = getStockColorHex(status);
            const movementCells = showMovement
                ? `<td class="text-right">${item.tonDau.toLocaleString('en-US')}</td>
                   <td class="text-right" style="color:var(--vh-green);">${item.nhap.toLocaleString('en-US')}</td>
                   <td class="text-right" style="color:var(--danger);">${item.xuat.toLocaleString('en-US')}</td>`
                : '';
            // Dòng ảo (mã đã cấu hình cảnh báo nhưng kế toán ẩn khỏi Sheet vì hết hàng) - thêm badge nhỏ để
            // anh phân biệt đây không phải dòng đọc trực tiếp từ Sheet lúc này, tránh nhầm là lỗi dữ liệu.
            const nameCell = item.isGhost
                ? `${escapeHtml(item.name)} <span class="badge badge-danger" style="margin-left:6px;">Ẩn khỏi DS kế toán</span>`
                : escapeHtml(item.name);
            const categoryCell = showCategoryColumn ? `<td class="text-left"><span class="badge badge-info">${escapeHtml(item.sheet)}</span></td>` : '';
            return `
            <tr>
                <td class="text-left font-bold">${escapeHtml(item.id)}</td>
                <td class="text-left">${nameCell}</td>
                <td>${escapeHtml(item.unit)}</td>
                ${movementCells}
                <td class="text-right" style="font-weight:bold; font-size:15px; color:${stockColor};">${item.stock.toLocaleString('en-US')}</td>
                ${categoryCell}
            </tr>
        `;
        });
        tbody.innerHTML = rowsHtml.join('');
    }

    document.getElementById('stat-total').innerText = filteredData.length;
    updateStockWarningStats(baseFilteredData, isPriceView);

    // Biểu đồ "Top tồn kho nhiều nhất" - chỉ có ý nghĩa trong từng danh mục cụ thể (đơn vị tính đồng nhất),
    // không hiện ở Dashboard Tổng (đơn vị khác nhau, cộng dồn vô nghĩa) hay tab Giá TB (không phải tồn kho).
    // Dùng baseFilteredData (đã áp search + hashtag đang chọn) để biểu đồ TỰ ĐỘNG cập nhật theo đúng bộ lọc
    // hiện tại - anh bấm hashtag nào thì biểu đồ liền phản ánh top tồn kho của đúng nhóm đó, không cần thêm
    // thao tác gì khác.
    renderStockChart(baseFilteredData, isPriceView);

    // Lưu lại đúng dữ liệu + thứ tự đang hiển thị (đã lọc + đã sort) để dùng khi xuất Excel
    lastRenderedData = filteredData;
    lastRenderedIsPriceView = isPriceView;
}

// Cập nhật 2 ô thống kê "Sắp hết hàng" / "Hết hàng" theo đúng dữ liệu đang hiển thị (đã lọc theo tab/tìm kiếm/hashtag).
// Tab "Giá TB" không có khái niệm tồn kho nên ẩn hẳn 2 ô này đi.
function updateStockWarningStats(items, isPriceView) {
    const lowWrap = document.getElementById('stat-low-wrap');
    const outWrap = document.getElementById('stat-out-wrap');
    if (!lowWrap || !outWrap) return;

    if (isPriceView) {
        lowWrap.style.display = 'none';
        outWrap.style.display = 'none';
        return;
    }

    let lowCount = 0;
    let outCount = 0;
    items.forEach(item => {
        const status = getStockStatus(item);
        if (status === 'low') lowCount++;
        else if (status === 'out') outCount++;
    });

    document.getElementById('stat-low').innerText = lowCount;
    document.getElementById('stat-out').innerText = outCount;
    lowWrap.style.display = '';
    outWrap.style.display = '';

    // Bấm được (đổi con trỏ + hover) chỉ khi count > 0; bằng 0 thì làm mờ nhẹ, bấm không có tác dụng
    lowWrap.classList.toggle('clickable', lowCount > 0);
    lowWrap.classList.toggle('not-clickable', lowCount === 0);
    outWrap.classList.toggle('clickable', outCount > 0);
    outWrap.classList.toggle('not-clickable', outCount === 0);

    // Tô đậm ô đang được dùng để lọc bảng
    lowWrap.classList.toggle('active-filter', stockFilterMode === 'low');
    outWrap.classList.toggle('active-filter', stockFilterMode === 'out');
}

// Xuất đúng dữ liệu ĐANG HIỂN THỊ trên bảng (đã áp dụng tab/tìm kiếm/hashtag/sắp xếp) ra file Excel thật (.xlsx)
function exportToExcel() {
    if (!hasPermission('EXPORT_INVENTORY')) return;
    if (typeof XLSX === 'undefined') {
        showAlert('Không tải được thư viện xuất Excel (có thể do mất mạng). Anh thử tải lại trang rồi bấm lại giúp em.', 'error');
        return;
    }

    if (!lastRenderedData || lastRenderedData.length === 0) {
        showAlert('Không có dữ liệu để xuất - anh kiểm tra lại bộ lọc/tìm kiếm hiện tại nhé.', 'error');
        return;
    }

    let rows;
    if (lastRenderedIsPriceView) {
        rows = lastRenderedData.map((item, index) => {
            const priceRaw = getPriceValue(item.raw);
            const priceNum = parseFloat(priceRaw);
            return {
                'Stt': index + 1,
                'Mã Vật Tư': item.id,
                'Tên Vật Tư': item.name,
                'ĐVT': item.unit,
                'Giá TB': isNaN(priceNum) ? priceRaw : priceNum
            };
        });
    } else {
        rows = lastRenderedData.map(item => {
            const row = { 'Mã Vật Tư': item.id, 'Tên Vật Tư': item.name, 'ĐVT': item.unit };
            if (showMovementColumns) {
                row['Tồn Đầu'] = item.tonDau;
                row['Nhập'] = item.nhap;
                row['Xuất'] = item.xuat;
            }
            row['Tồn Kho'] = item.stock;
            row['Danh Mục'] = item.sheet;
            return row;
        });
    }

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Ton kho NVL');

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
    const categoryLabel = currentCategory === 'ALL' ? 'TatCa' : currentCategory.replace(/\s+/g, '');

    XLSX.writeFile(workbook, `TonKhoNVL_${categoryLabel}_${timestamp}.xlsx`);
}

// ---- PANEL CẤU HÌNH CẢNH BÁO TỒN KHO ----

let pendingThresholdItem = null; // mã vật tư đang được chọn từ ô gợi ý, chờ bấm "+ Thêm"

// Danh sách toàn bộ panel cấp cao trong app - dùng để ẩn hết rồi chỉ hiện đúng 1 panel cần xem
const ALL_PANEL_IDS = ['inventory-panel', 'threshold-config-panel', 'reorder-panel', 'accounts-panel', 'stagnant-panel'];

function showOnlyPanel(panelIdToShow) {
    ALL_PANEL_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = (id === panelIdToShow) ? 'block' : 'none';
    });
}

function openThresholdConfigPanel() {
    if (!hasPermission('EDIT_THRESHOLDS')) return;
    showOnlyPanel('threshold-config-panel');
    renderThresholdConfigTable();
}

function closeThresholdConfigPanel() {
    showOnlyPanel('inventory-panel');
}

function openReorderPanel() {
    if (!hasPermission('VIEW_REORDER')) return;
    showOnlyPanel('reorder-panel');
    renderReorderPanel();
}

function closeReorderPanel() {
    showOnlyPanel('inventory-panel');
}

// Lưu ngưỡng số tháng "hàng đọng" (chỉ admin) - gọi Apps Script ghi vào sheet cấu hình
function saveStagnantMonths() {
    if (!hasPermission('EDIT_STAGNANT_CONFIG')) return;
    const months = parseInt(document.getElementById('stagnantMonthsInput').value, 10);
    const status = document.getElementById('stagnantSaveStatus');
    const btn = document.getElementById('btn-save-stagnant');

    if (!months || months < 1) {
        status.style.color = 'var(--danger)';
        status.innerText = 'Số tháng phải ≥ 1';
        return;
    }

    btn.disabled = true;
    status.style.color = '#64748b';
    status.innerText = 'Đang lưu...';

    fetch(GAS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'saveStagnantMonths', months: months, token: currentUser.token })
    })
        .then(res => res.json())
        .then(data => {
            if (isUnauthorizedResponse(data)) return;
            if (data && data.success) {
                stagnantMonths = months;
                status.style.color = 'var(--vh-green-dark)';
                status.innerText = '✅ Đã lưu';
            } else {
                status.style.color = 'var(--danger)';
                status.innerText = '❌ ' + ((data && data.error) || 'Lưu thất bại');
            }
        })
        .catch(() => {
            status.style.color = 'var(--danger)';
            status.innerText = '❌ Không kết nối được máy chủ';
        })
        .finally(() => { btn.disabled = false; });
}

// ---- PANEL HÀNG TỒN ĐỌNG ----
function openStagnantPanel() {
    if (!hasPermission('VIEW_STAGNANT')) return;
    showOnlyPanel('stagnant-panel');
    renderStagnantPanel();
}

function closeStagnantPanel() {
    showOnlyPanel('inventory-panel');
}

// Tính danh sách "hàng đọng": mã nào có số tồn KHÔNG đổi qua N mốc snapshot gần nhất liên tiếp
// (N = stagnantMonths), và số tồn đó > 0 (tồn = 0 thì là hết hàng, không phải đọng).
function getStagnantList() {
    const dates = stockHistory.dates || [];
    const data = stockHistory.data || {};
    const N = stagnantMonths;

    // Cần ít nhất N mốc chụp mới đủ dữ liệu kết luận "không đổi suốt N tháng"
    if (dates.length < N) return { notEnoughData: true, needed: N, have: dates.length, items: [] };

    const items = [];
    Object.keys(data).forEach(code => {
        const series = data[code];
        // Lấy N giá trị gần nhất (cuối mảng)
        const recent = series.slice(-N);
        // Bỏ qua nếu thiếu dữ liệu ở bất kỳ mốc nào trong N mốc đó (mã mới xuất hiện chưa đủ lịch sử)
        if (recent.some(v => v === null || v === undefined)) return;
        const first = recent[0];
        if (first <= 0) return; // tồn = 0 là hết hàng, không tính đọng
        const allSame = recent.every(v => v === first);
        if (allSame) {
            const item = flatInventoryList.find(i => String(i.id) === String(code) && !isPriceSheetName(i.sheet));
            items.push({
                id: code,
                name: item ? item.name : '(không rõ tên)',
                unit: item ? item.unit : '',
                sheet: item ? item.sheet : '',
                stock: first,
                months: N
            });
        }
    });

    items.sort((a, b) => b.stock - a.stock);
    return { notEnoughData: false, items: items };
}

function renderStagnantPanel() {
    const container = document.getElementById('stagnant-content');
    const result = getStagnantList();

    if (result.notEnoughData) {
        container.innerHTML = `
            <p style="color:#64748b; font-size:13.5px; line-height:1.6;">
                ⏳ Chưa đủ dữ liệu để phân tích. Tính năng này cần dữ liệu chụp tồn kho tự động mỗi đầu tháng —
                cần ít nhất <b>${result.needed} mốc</b> (tương ứng ${result.needed} tháng) để kết luận 1 mã có "đọng" hay không,
                hiện mới có <b>${result.have} mốc</b>.<br><br>
                Cứ để hệ thống chạy tự động, sau đủ ${result.needed} tháng sẽ có kết quả. (Đây là đặc điểm của phương pháp
                theo dõi theo thời gian, giống như mới lắp camera thì phải chờ quay đủ lâu mới xem lại được.)
            </p>`;
        return;
    }

    if (result.items.length === 0) {
        container.innerHTML = `
            <p style="color:var(--vh-green-dark); font-size:13.5px;">
                ✅ Không có mã nào bị tồn đọng quá ${stagnantMonths} tháng. Kho đang luân chuyển tốt!
            </p>`;
        return;
    }

    const rows = result.items.map(item => `
        <tr>
            <td class="text-left font-bold">${escapeHtml(item.id)}</td>
            <td class="text-left">${escapeHtml(item.name)}</td>
            <td class="text-left"><span class="badge badge-info">${escapeHtml(item.sheet)}</span></td>
            <td>${escapeHtml(item.unit)}</td>
            <td class="text-right" style="font-weight:bold;">${item.stock.toLocaleString('en-US')}</td>
        </tr>
    `).join('');

    container.innerHTML = `
        <p style="color:#64748b; font-size:13px; margin-top:-6px; margin-bottom:8px;">
            Các mã có số tồn <b>không thay đổi liên tục suốt ${stagnantMonths} tháng gần nhất</b> (không nhập, không xuất) — nên xem xét đẩy hàng để tận dụng vốn.
        </p>
        <p style="color:#94a3b8; font-size:12px; margin-top:0; margin-bottom:18px;">
            💡 Dựa trên dữ liệu chụp tồn kho tự động mỗi đầu tháng. Ngưỡng ${stagnantMonths} tháng do quản trị viên đặt (chỉnh ở tab ⚙️ Cảnh báo tồn kho).
        </p>
        <div style="margin-bottom:14px; font-size:13.5px; font-weight:700; color:var(--danger);">
            ⚠️ Có ${result.items.length} mã đang tồn đọng, cần xem xét.
        </div>
        <div class="table-responsive">
            <table>
                <thead>
                    <tr>
                        <th class="text-left">Mã Vật Tư</th>
                        <th class="text-left">Tên Vật Tư</th>
                        <th class="text-left">Danh Mục</th>
                        <th>ĐVT</th>
                        <th class="text-right">Tồn (không đổi)</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

// ---- PANEL QUẢN LÝ TÀI KHOẢN / PHÂN QUYỀN (Admin) ----
let accountsList = [];
let accountSortState = { key: 'createdAt', dir: 'desc' };
let rolePermissionMatrix = {};
let rolePermissionKeys = [];
let rolePermissionRoles = [];

function openAccountsPanel() {
    if (!currentUser || !isAdminUser()) return;
    showOnlyPanel('accounts-panel');
    switchAdminSection('users');
    loadAccounts();
}

async function refreshPendingBadge() {
    const badge = document.getElementById('pending-badge');
    if (!badge || !currentUser || !isAdminUser()) return;
    try {
        const data = await apiPost('listUsers', { token: currentUser.token });
        if (isUnauthorizedResponse(data)) return;
        if (!data || !data.success) return;
        const count = (data.users || []).filter(u => u.status === 'pending_approval').length;
        badge.innerText = String(count);
        badge.style.display = count > 0 ? 'inline-flex' : 'none';
    } catch (err) {
        console.error('Không tải được số tài khoản chờ duyệt:', err);
    }
}

function closeAccountsPanel() { showOnlyPanel('inventory-panel'); }

function switchAdminSection(section) {
    const users = section === 'users';
    document.getElementById('admin-users-section').style.display = users ? 'block' : 'none';
    document.getElementById('admin-permissions-section').style.display = users ? 'none' : 'block';
    document.getElementById('admin-tab-users').classList.toggle('active', users);
    document.getElementById('admin-tab-permissions').classList.toggle('active', !users);
    if (!users) loadRolePermissions();
}

async function loadAccounts() {
    if (!currentUser || !isAdminUser()) return;
    const loading = document.getElementById('accounts-loading');
    const wrap = document.getElementById('accounts-table-wrap');
    loading.style.display = 'block';
    loading.innerText = 'Đang tải danh sách tài khoản...';
    wrap.style.display = 'none';
    try {
        const data = await apiPost('listUsers', { token: currentUser.token });
        if (isUnauthorizedResponse(data)) return;
        if (!data || !data.success) throw new Error((data && data.error) || 'LOAD_FAILED');
        accountsList = Array.isArray(data.users) ? data.users : [];
        populateAccountFilters();
        renderAccountsTable();
        loading.style.display = 'none';
        wrap.style.display = 'block';
    } catch (err) {
        console.error('Lỗi tải Users:', err);
        loading.innerText = '❌ Không tải được danh sách tài khoản.';
    }
}

function populateAccountFilters() {
    const roleFilter = document.getElementById('accountRoleFilter');
    const deptFilter = document.getElementById('accountDepartmentFilter');
    const currentRole = roleFilter.value;
    const currentDept = deptFilter.value;
    roleFilter.innerHTML = '<option value="">Tất cả vai trò</option>' + ROLE_OPTIONS.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
    const departments = Array.from(new Set(accountsList.map(a => a.department).filter(Boolean))).sort((a,b) => a.localeCompare(b, 'vi'));
    deptFilter.innerHTML = '<option value="">Tất cả phòng ban</option>' + departments.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    if (Array.from(roleFilter.options).some(o => o.value === currentRole)) roleFilter.value = currentRole;
    if (Array.from(deptFilter.options).some(o => o.value === currentDept)) deptFilter.value = currentDept;
}

function getFilteredAccounts() {
    const term = (document.getElementById('accountSearchInput').value || '').trim().toLowerCase();
    const role = document.getElementById('accountRoleFilter').value;
    const dept = document.getElementById('accountDepartmentFilter').value;
    let list = accountsList.filter(a => {
        const hay = `${a.userId} ${a.companyId || ''} ${a.name} ${a.email}`.toLowerCase();
        const roles = Array.isArray(a.roles) ? a.roles : [a.role].filter(Boolean);
        return (!term || hay.includes(term)) && (!role || roles.includes(role)) && (!dept || a.department === dept);
    });
    const key = accountSortState.key;
    const dir = accountSortState.dir === 'asc' ? 1 : -1;
    list = list.slice().sort((a,b) => {
        if (key === 'createdAt') return (new Date(a.createdAt || 0) - new Date(b.createdAt || 0)) * dir;
        const av = key === 'role' ? roleDisplayLabel(a.roles || [a.role]) : String(a[key] == null ? '' : a[key]);
        const bv = key === 'role' ? roleDisplayLabel(b.roles || [b.role]) : String(b[key] == null ? '' : b[key]);
        return av.localeCompare(bv, 'vi', { numeric:true, sensitivity:'base' }) * dir;
    });
    return list;
}

function updateAccountSortIndicators() {
    document.querySelectorAll('.account-sort-btn').forEach(btn => {
        const active = btn.dataset.sortKey === accountSortState.key;
        btn.classList.toggle('active', active);
        const icon = btn.querySelector('.account-sort-icon');
        if (icon) icon.textContent = active ? (accountSortState.dir === 'asc' ? '▲' : '▼') : '↕';
    });
}

function toggleAccountHeaderSort(event) {
    const btn = event.target.closest('.account-sort-btn[data-sort-key]');
    if (!btn) return;
    const key = btn.dataset.sortKey;
    if (accountSortState.key === key) accountSortState.dir = accountSortState.dir === 'asc' ? 'desc' : 'asc';
    else {
        accountSortState.key = key;
        accountSortState.dir = key === 'createdAt' ? 'desc' : 'asc';
    }
    renderAccountsTable();
}

function handleAccountSortSelectChange() {
    const value = document.getElementById('accountSortSelect').value;
    const map = {
        created_desc: { key:'createdAt', dir:'desc' },
        name_asc: { key:'name', dir:'asc' },
        email_asc: { key:'email', dir:'asc' },
        companyid_asc: { key:'companyId', dir:'asc' },
        userid_asc: { key:'userId', dir:'asc' }
    };
    accountSortState = map[value] || { key:'createdAt', dir:'desc' };
    renderAccountsTable();
}

function roleColorClass(role) { return `account-role-${String(role || '').replace(/[^a-z0-9_]/gi, '')}`; }
function statusColorClass(status) { return `account-status-${String(status || '').replace(/[^a-z0-9_]/gi, '')}`; }

function normalizedAccountRoles(acc) {
    const roles = Array.isArray(acc.roles) ? acc.roles.slice() : [acc.role].filter(Boolean);
    return roles.length ? roles : ['viewer'];
}

function roleChipHtml(role) {
    return `<span class="account-role-chip ${roleColorClass(role)}">${escapeHtml(ROLE_LABELS[role] || role)}</span>`;
}

function renderAccountsTable() {
    const tbody = document.getElementById('accountsTableBody');
    if (!tbody) return;
    const list = getFilteredAccounts();
    updateAccountSortIndicators();
    if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="color:#94a3b8; padding:16px;">Không có tài khoản phù hợp.</td></tr>';
        return;
    }
    tbody.innerHTML = list.map(acc => {
        const role = acc.role || (Array.isArray(acc.roles) && acc.roles[0]) || 'viewer';
        const isConfiguredAdmin = acc.email && currentUser && acc.email.toLowerCase() === currentUser.email.toLowerCase() && role === 'admin';
        const roleOptionsHtml = ROLE_OPTIONS.map(o => `<option value="${escapeHtml(o.value)}"${o.value === role ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
        const statusHtml = STATUS_OPTIONS.map(o => `<option value="${escapeHtml(o.value)}"${o.value === acc.status ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
        const created = acc.createdAt ? new Date(acc.createdAt).toLocaleDateString('vi-VN') : '-';
        const rowStyle = acc.status === 'pending_approval' ? ' style="background:#fff8ec;"' : '';
        return `<tr data-user-id="${escapeHtml(acc.userId)}"${rowStyle}>
            <td class="text-left font-bold">${escapeHtml(acc.userId)}</td>
            <td class="text-left"><div class="company-id-editor"><input class="form-control account-company-id-input" maxlength="40" value="${escapeHtml(acc.companyId || '')}" placeholder="Mã ID công ty" style="min-width:120px;margin:0;"><span class="company-id-save-state" aria-live="polite"></span></div></td>
            <td class="text-left">${escapeHtml(acc.name || '-')}</td>
            <td class="text-left">${escapeHtml(acc.email)}</td>
            <td class="text-left">${escapeHtml(acc.department || '-')}</td>
            <td><select class="form-control account-role-select ${roleColorClass(role)}" style="max-width:190px;margin:0 auto;"${isConfiguredAdmin ? ' disabled' : ''}>${roleOptionsHtml}</select></td>
            <td><select class="form-control account-status-select ${statusColorClass(acc.status)}" style="max-width:130px;margin:0 auto;">${statusHtml}</select></td>
            <td>${escapeHtml(created)}</td>
        </tr>`;
    }).join('');
}

async function saveAccountRow(row, control) {
    const userId = row.dataset.userId;
    const companyId = row.querySelector('.account-company-id-input').value.trim();
    const role = row.querySelector('.account-role-select').value;
    const statusValue = row.querySelector('.account-status-select').value;
    const status = document.getElementById('accountsSaveStatus');
    const inlineState = row.querySelector('.company-id-save-state');
    const isCompanyIdChange = !!(control && control.classList && control.classList.contains('account-company-id-input'));
    const controls = row.querySelectorAll('input,select');
    controls.forEach(el => { el.disabled = true; });
    status.style.color = '#64748b';
    status.innerText = `Đang lưu ${userId}...`;
    if (isCompanyIdChange && inlineState) { inlineState.className = 'company-id-save-state'; inlineState.textContent = 'Đang lưu...'; }
    try {
        const data = await apiPost('updateUser', { token: currentUser.token, userId, companyId, role, status: statusValue });
        if (isUnauthorizedResponse(data)) return;
        if (!data || !data.success) {
            status.style.color = 'var(--danger)';
            status.innerText = '❌ ' + ((data && data.error) || 'Không lưu được thay đổi.');
            if (isCompanyIdChange && inlineState) { inlineState.className = 'company-id-save-state error'; inlineState.textContent = '✕ Lỗi'; }
            await loadAccounts();
            return;
        }
        status.style.color = 'var(--vh-green-dark)';
        status.innerText = `✅ Đã lưu ${userId}`;
        if (isCompanyIdChange && inlineState) { inlineState.className = 'company-id-save-state ok'; inlineState.textContent = '✓ Đã lưu'; }
        const target = accountsList.find(a => a.userId === userId);
        if (target) {
            target.companyId = companyId;
            target.role = data.role || role;
            target.roles = [target.role];
            target.status = statusValue;
        }
        refreshPendingBadge();
        renderAccountsTable();
    } catch (err) {
        console.error('Lỗi cập nhật user:', err);
        status.style.color = 'var(--danger)';
        status.innerText = '❌ Không kết nối được máy chủ.';
        if (isCompanyIdChange && inlineState) { inlineState.className = 'company-id-save-state error'; inlineState.textContent = '✕ Lỗi'; }
        await loadAccounts();
    } finally {
        controls.forEach(el => { el.disabled = false; });
    }
}

async function handleAccountTableChange(event) {
    const control = event.target;
    const row = control.closest('tr[data-user-id]');
    if (!row) return;

    if (control.classList.contains('account-role-checkbox')) {
        const role = control.value;
        const boxes = Array.from(row.querySelectorAll('.account-role-checkbox'));
        if (role === 'admin' && control.checked) {
            boxes.forEach(box => { if (box.value !== 'admin') box.checked = false; });
        } else if (role !== 'admin' && control.checked) {
            const adminBox = boxes.find(box => box.value === 'admin');
            if (adminBox && !adminBox.disabled) adminBox.checked = false;
        }
        await saveAccountRow(row, control);
        return;
    }

    if (control.classList.contains('account-role-select') || control.classList.contains('account-status-select') || control.classList.contains('account-company-id-input')) {
        await saveAccountRow(row, control);
    }
}

async function loadRolePermissions() {
    if (!currentUser || !isAdminUser()) return;
    const loading = document.getElementById('permissions-loading');
    const wrap = document.getElementById('permissions-table-wrap');
    loading.style.display = 'block';
    loading.innerText = 'Đang tải ma trận quyền...';
    wrap.style.display = 'none';
    try {
        const data = await apiPost('getRolePermissions', { token: currentUser.token });
        if (isUnauthorizedResponse(data)) return;
        if (!data || !data.success) throw new Error((data && data.error) || 'LOAD_FAILED');
        rolePermissionMatrix = data.matrix || {};
        rolePermissionKeys = Array.isArray(data.permissionKeys) ? data.permissionKeys : [];
        rolePermissionRoles = Array.isArray(data.roles) ? data.roles : [];
        renderRolePermissions();
        loading.style.display = 'none';
        wrap.style.display = 'block';
    } catch (err) {
        console.error('Lỗi tải RolePermissions:', err);
        loading.innerText = '❌ Không tải được ma trận quyền.';
    }
}

function renderRolePermissions() {
    const head = document.getElementById('permissionsTableHead');
    const body = document.getElementById('permissionsTableBody');
    head.innerHTML = '<th>Chức năng</th>' + rolePermissionRoles.map(role => `<th>${escapeHtml(ROLE_LABELS[role] || role)}</th>`).join('');
    body.innerHTML = rolePermissionKeys.map(key => {
        const locked = key === 'MANAGE_ACCOUNTS' || key === 'MANAGE_ROLE_PERMISSIONS';
        const cells = rolePermissionRoles.map(role => {
            const checked = !!(rolePermissionMatrix[role] && rolePermissionMatrix[role][key]);
            return `<td><input type="checkbox" class="permission-checkbox" data-role="${escapeHtml(role)}" data-key="${escapeHtml(key)}"${checked ? ' checked' : ''}${locked ? ' disabled' : ''}></td>`;
        }).join('');
        const label = PERMISSION_LABELS[key] || key;
        return `<tr><td>${escapeHtml(label)}${locked ? ' <span style="color:#94a3b8;font-size:11px;">(chỉ Admin)</span>' : ''}</td>${cells}</tr>`;
    }).join('');
}

async function saveRolePermissions() {
    if (!currentUser || !isAdminUser()) return;
    const btn = document.getElementById('btn-save-role-permissions');
    const status = document.getElementById('permissionsSaveStatus');
    const matrix = {};
    rolePermissionRoles.forEach(role => { matrix[role] = {}; });
    document.querySelectorAll('.permission-checkbox').forEach(box => {
        if (!matrix[box.dataset.role]) matrix[box.dataset.role] = {};
        matrix[box.dataset.role][box.dataset.key] = box.checked && !box.disabled;
    });
    btn.disabled = true;
    status.style.color = '#64748b';
    status.innerText = 'Đang lưu phân quyền...';
    try {
        const data = await apiPost('saveRolePermissions', { token: currentUser.token, matrix });
        if (isUnauthorizedResponse(data)) return;
        if (!data || !data.success) {
            status.style.color = 'var(--danger)';
            status.innerText = '❌ ' + ((data && data.error) || 'Lưu thất bại.');
            return;
        }
        rolePermissionMatrix = data.matrix || matrix;
        status.style.color = 'var(--vh-green-dark)';
        status.innerText = '✅ Đã lưu phân quyền';
        renderRolePermissions();
    } catch (err) {
        console.error('Lỗi lưu RolePermissions:', err);
        status.style.color = 'var(--danger)';
        status.innerText = '❌ Không kết nối được máy chủ.';
    } finally {
        btn.disabled = false;
    }
}

// Gợi ý mã/tên vật tư khi gõ - tối đa 8 kết quả để không dài quá
function renderThresholdSuggestions() {
    const box = document.getElementById('thresholdSuggestions');
    const term = document.getElementById('thresholdSearchInput').value.trim().toLowerCase();
    pendingThresholdItem = null; // gõ lại thì hủy lựa chọn cũ, tránh lỡ tay thêm nhầm mã

    if (!term) {
        box.innerHTML = '';
        box.style.display = 'none';
        return;
    }

    // Loại bỏ sheet "Giá TB" khỏi kết quả gợi ý - đây chỉ là bảng giá tham khảo, không có khái niệm tồn kho,
    // nên không có ý nghĩa để cấu hình cảnh báo. Quan trọng hơn: mỗi mã vật tư đều có 1 dòng lặp lại bên
    // sheet Giá TB (trùng id/tên với dòng bên sheet danh mục thật) - nếu không loại ra, anh rất dễ bấm nhầm
    // vào dòng Giá TB, khiến mã bị gắn sai danh mục và "biến mất" khỏi cảnh báo tồn kho của danh mục thật.
    const matches = flatInventoryList.filter(item => {
        if (isPriceSheetName(item.sheet)) return false;
        const id = String(item.id || '').toLowerCase();
        const name = String(item.name || '').toLowerCase();
        return id.includes(term) || name.includes(term);
    }).slice(0, 8);

    if (matches.length === 0) {
        // Ô gợi ý này nổi lên trên (position:absolute) nên nó đang đè mất dòng link "Nhập thủ công" nằm phía dưới -
        // đưa thẳng nút thủ công vào TRONG ô gợi ý luôn để anh luôn bấm được, không bị che khuất.
        box.innerHTML = `
            <div class="threshold-suggestion-empty">Không tìm thấy mã vật tư phù hợp</div>
            <div class="threshold-suggestion-item" style="color:var(--vh-blue); font-weight:600;" onclick="openManualFormFromSuggestion()">
                + Không có trong danh sách - Nhập thủ công mã này
            </div>
        `;
        box.style.display = 'block';
        return;
    }

    box.innerHTML = matches.map(item => {
        const safeId = escapeHtml(item.id).replace(/"/g, '&quot;');
        const safeName = escapeHtml(item.name).replace(/"/g, '&quot;');
        const safeSheet = escapeHtml(item.sheet).replace(/"/g, '&quot;');
        const safeUnit = escapeHtml(item.unit).replace(/"/g, '&quot;');
        // Hiện rõ danh mục ngay trong gợi ý - phòng trường hợp còn mã trùng tên/mã ở nơi khác,
        // anh vẫn nhìn thấy rõ đang chọn đúng danh mục nào trước khi bấm.
        return `<div class="threshold-suggestion-item" onclick="selectThresholdItem('${safeId.replace(/'/g, "\\'")}', '${safeName.replace(/'/g, "\\'")}', '${safeSheet.replace(/'/g, "\\'")}', '${safeUnit.replace(/'/g, "\\'")}')">
            <strong>${safeId}</strong> - ${safeName} <span style="color:#94a3b8;">(${safeSheet})</span>
        </div>`;
    }).join('');
    box.style.display = 'block';
}

// Lưu kèm danh mục (sheet) + đvt của mã lúc còn thấy trong tồn kho - để sau này nếu kế toán ẩn dòng
// (tồn = 0) khỏi Sheet gốc, app vẫn biết mã này thuộc danh mục nào, đvt gì để dựng lại "dòng ảo" hiển thị đúng chỗ.
function selectThresholdItem(id, name, sheet, unit) {
    pendingThresholdItem = { id: id, name: name, sheet: sheet, unit: unit };
    document.getElementById('thresholdSearchInput').value = `${id} - ${name}`;
    document.getElementById('thresholdSuggestions').innerHTML = '';
    document.getElementById('thresholdSuggestions').style.display = 'none';
    // Đang gõ tìm bình thường thì ẩn form thủ công đi (nếu lỡ đang mở) để khỏi rối giao diện
    hideManualThresholdForm();
}

// ---- NHẬP THỦ CÔNG MÃ VẬT TƯ CHƯA CÓ TRONG DỮ LIỆU ----
// Dùng khi mã cần cấu hình cảnh báo là mã QUAN TRỌNG nhưng tồn = 0 và kế toán chưa từng nhập / đã ẩn hẳn
// khỏi Sheet, nên không thể tìm ra để chọn theo cách bình thường (renderThresholdSuggestions chỉ tìm được
// trong flatInventoryList - dữ liệu thật đã tải về). Sau khi xác nhận, mã này được coi như 1 "dòng ảo"
// (tồn = 0) ngay từ bây giờ, tới khi nào kế toán nhập mã đó vào Sheet thật thì dữ liệu thật sẽ ghi đè lên.
// Mở form nhập thủ công ngay từ trong ô gợi ý (khi bấm "+ Không có trong danh sách...") - đóng hẳn dropdown
// gợi ý trước, vì nó đang nổi đè lên (position:absolute) khiến form thủ công phía dưới bị che mất nếu không đóng lại.
function openManualFormFromSuggestion() {
    document.getElementById('thresholdSuggestions').innerHTML = '';
    document.getElementById('thresholdSuggestions').style.display = 'none';
    document.getElementById('manualThresholdForm').style.display = 'none'; // đảm bảo đang đóng trước khi gọi toggle mở lại
    toggleManualThresholdForm();
}

function toggleManualThresholdForm() {
    const form = document.getElementById('manualThresholdForm');
    const isHidden = form.style.display === 'none';
    if (isHidden) {
        // Nạp danh sách danh mục mỗi lần mở form - đề phòng dữ liệu vừa được làm mới nên danh mục có thể đổi
        const select = document.getElementById('manualSheet');
        select.innerHTML = knownCategories.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
        form.style.display = 'flex';
        document.getElementById('manualId').value = document.getElementById('thresholdSearchInput').value.trim();
        document.getElementById('thresholdSuggestions').innerHTML = '';
        document.getElementById('thresholdSuggestions').style.display = 'none';
    } else {
        hideManualThresholdForm();
    }
}

function hideManualThresholdForm() {
    document.getElementById('manualThresholdForm').style.display = 'none';
    document.getElementById('manualThresholdHint').style.display = 'none';
}

// Sinh 1 mã tạm duy nhất từ tên vật tư khi anh không nhập mã (chưa biết mã thật hoặc chưa muốn nghĩ mã) -
// tiền tố "TAM_" để dễ nhận ra đây KHÔNG phải mã thật bên kế toán, tránh trùng vô tình với mã có sẵn.
// Hậu quả cần lưu ý: vì mã tạm không khớp với mã thật, nên khi kế toán sau này nhập mã thật vào Sheet,
// "dòng ảo" (dùng mã tạm) sẽ KHÔNG tự động được thay bằng dòng thật - anh cần vào xóa mã tạm và thêm lại
// đúng mã thật 1 lần để 2 bên khớp nhau (xem thêm giải thích ở nameCell/isGhost).
function confirmManualThresholdEntry() {
    const id = document.getElementById('manualId').value.trim();
    const name = document.getElementById('manualName').value.trim();
    const sheet = document.getElementById('manualSheet').value;
    const unit = document.getElementById('manualUnit').value.trim();

    // Bắt buộc phải có mã - không để hệ thống tự sinh mã ngẫu nhiên (dễ quên, dễ tạo trùng lặp âm thầm
    // nếu lỡ bấm xác nhận nhiều lần). Nếu chưa biết mã thật bên kế toán, anh tự đặt 1 mã tạm dễ nhớ
    // (VD: "TAM-THEP60") - miễn là chính anh chủ động biết và nhớ được mã đó là gì.
    if (!id || !name) {
        showAlert('Anh nhập đủ Mã vật tư và Tên vật tư trước khi xác nhận nhé. Nếu chưa biết mã thật, anh tự đặt 1 mã tạm dễ nhớ (VD: TAM-THEP60) để sau này còn tìm lại được.', 'error');
        return;
    }
    if (!sheet) {
        showAlert('Chưa có danh mục nào để chọn - anh Làm mới dữ liệu 1 lần cho có dữ liệu danh mục rồi thử lại nhé.', 'error');
        return;
    }

    // Cảnh báo nhẹ nếu mã này thực ra ĐÃ có sẵn trong dữ liệu thật - tránh trường hợp anh gõ nhầm mã đã tồn tại,
    // vì nếu vậy nên dùng ô tìm kiếm phía trên để chọn đúng dòng thật (có đầy đủ tồn kho hiện tại) thay vì nhập thủ công.
    const alreadyReal = flatInventoryList.some(i => String(i.id).toLowerCase() === id.toLowerCase() && !isPriceSheetName(i.sheet));

    const finishManualEntry = function () {
        pendingThresholdItem = { id: id, name: name, sheet: sheet, unit: unit };
        document.getElementById('thresholdSearchInput').value = `${id} - ${name} (nhập thủ công)`;
        hideManualThresholdForm();
        document.getElementById('manualThresholdHint').style.display = 'block';
    };

    if (alreadyReal) {
        showConfirm(`Mã "${id}" hình như đã có sẵn trong dữ liệu tồn kho thật. Anh có chắc muốn nhập thủ công đè lên không? (Nên dùng ô tìm kiếm phía trên để chọn đúng dòng thật thay vì bấm ở đây)`, finishManualEntry);
    } else {
        finishManualEntry();
    }
}

function addThresholdItem() {
    if (!canEditThresholds()) return;
    if (!pendingThresholdItem) {
        showAlert('Anh gõ mã/tên vật tư rồi bấm chọn đúng 1 dòng trong danh sách gợi ý hiện ra bên dưới đã nhé.', 'error');
        return;
    }

    const thresholdVal = parseFloat(document.getElementById('thresholdValueInput').value);
    if (isNaN(thresholdVal) || thresholdVal < 0) {
        showAlert('Anh nhập ngưỡng cảnh báo là 1 số >= 0 nhé.', 'error');
        return;
    }

    const existing = thresholdConfig.find(t => t.id === pendingThresholdItem.id);
    if (existing) {
        existing.threshold = thresholdVal; // đã có rồi thì cập nhật lại ngưỡng mới
        existing.name = pendingThresholdItem.name; // cập nhật lại tên/danh mục/đvt mới nhất luôn, phòng khi trước đó lưu bị thiếu
        existing.sheet = pendingThresholdItem.sheet;
        existing.unit = pendingThresholdItem.unit;
        existing.markedForDelete = false; // lỡ bấm Xóa nhầm trước đó thì thêm lại là tự hủy đánh dấu luôn
    } else {
        thresholdConfig.push({
            id: pendingThresholdItem.id,
            name: pendingThresholdItem.name,
            sheet: pendingThresholdItem.sheet,
            unit: pendingThresholdItem.unit,
            threshold: thresholdVal
        });
    }

    document.getElementById('thresholdSearchInput').value = '';
    document.getElementById('thresholdValueInput').value = '';
    pendingThresholdItem = null;
    hideManualThresholdForm();

    rebuildThresholdMap();
    renderThresholdConfigTable();
}

// Bấm "Xóa" chỉ ĐÁNH DẤU dòng đó là "chờ xóa" (tô cam) chứ chưa xóa thật ngay - giống hệt cách "Thêm" chỉ
// nằm trên web cho tới khi bấm "Lưu Lên Google Sheet". Làm vậy để anh có thể xem lại/đổi ý (bấm lại để huỷ đánh dấu)
// trước khi xóa thật, và để hành vi giữa "Xóa" và "Thêm" nhất quán - đều cần bấm Lưu mới ghi thật lên Sheet.
function toggleMarkForDelete(id) {
    if (!canEditThresholds()) return;
    const target = thresholdConfig.find(t => t.id === id);
    if (target) target.markedForDelete = !target.markedForDelete;
    renderThresholdConfigTable();
}

function toggleThresholdSortColumn(column) {
    if (thresholdSortState.column === column) {
        thresholdSortState.direction = thresholdSortState.direction === 'asc' ? 'desc' : 'asc';
    } else {
        thresholdSortState.column = column;
        thresholdSortState.direction = 'asc';
    }
    renderThresholdConfigTable();
}

function updateThresholdSortArrows() {
    ['id', 'name'].forEach(col => {
        const el = document.getElementById('thresholdSortArrow_' + col);
        if (!el) return;
        if (thresholdSortState.column !== col) {
            el.textContent = '↕';
            el.className = 'sort-arrow sort-arrow-inactive';
        } else {
            el.textContent = thresholdSortState.direction === 'asc' ? '▲' : '▼';
            el.className = 'sort-arrow sort-arrow-active';
        }
    });
}

// Dựng lại dropdown lọc danh mục theo đúng các danh mục THỰC TẾ đang có trong thresholdConfig (không phải
// toàn bộ knownCategories) - để không hiện danh mục nào chẳng có mã nào được cấu hình cảnh báo cả, đỡ rối.
function renderThresholdCategoryFilterOptions() {
    const select = document.getElementById('thresholdCategoryFilterSelect');
    if (!select) return;
    const categoriesInUse = Array.from(new Set(thresholdConfig.map(t => t.sheet).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'vi'));

    // Nếu danh mục đang được chọn lọc không còn mã nào nữa (VD vừa xóa hết mã của danh mục đó) thì tự về "Tất cả"
    if (thresholdCategoryFilter && !categoriesInUse.includes(thresholdCategoryFilter)) {
        thresholdCategoryFilter = '';
    }

    select.innerHTML = '<option value="">Tất cả danh mục</option>' +
        categoriesInUse.map(name => `<option value="${escapeHtml(name)}"${name === thresholdCategoryFilter ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('');
}

function renderThresholdConfigTable() {
    const tbody = document.getElementById('thresholdConfigTableBody');

    renderThresholdCategoryFilterOptions();
    updateThresholdSortArrows();

    let list = thresholdCategoryFilter
        ? thresholdConfig.filter(t => t.sheet === thresholdCategoryFilter)
        : thresholdConfig.slice();

    if (thresholdSortState.column) {
        const dir = thresholdSortState.direction === 'asc' ? 1 : -1;
        const field = thresholdSortState.column; // 'id' hoặc 'name'
        list.sort((a, b) => String(a[field] || '').localeCompare(String(b[field] || ''), 'vi', { numeric: true }) * dir);
    }

    if (list.length === 0) {
        const emptyMsg = thresholdConfig.length === 0
            ? 'Chưa có mã vật tư nào được cấu hình cảnh báo. Anh tìm và thêm mã ở ô phía trên nhé.'
            : `Không có mã nào thuộc danh mục "${escapeHtml(thresholdCategoryFilter)}" trong danh sách cảnh báo.`;
        tbody.innerHTML = `<tr><td colspan="5" style="color:#94a3b8; padding:16px;">${emptyMsg}</td></tr>`;
        applyThresholdPermissionUI();
        return;
    }

    tbody.innerHTML = list.map(t => {
        // Dòng đang được đánh dấu chờ xóa -> tô nền cam để dễ nhận biết, và đổi nút "Xóa" thành "Hoàn tác"
        const rowStyle = t.markedForDelete ? ' style="background:#fff3cd;"' : '';
        const btnLabel = t.markedForDelete ? '↩️ Hoàn tác' : 'Xóa';
        const safeIdAttr = String(t.id).replace(/'/g, "\\'");
        return `
        <tr${rowStyle}>
            <td class="text-left font-bold">${escapeHtml(t.id)}</td>
            <td class="text-left">${escapeHtml(t.name)}</td>
            <td class="text-left">${t.sheet ? `<span class="badge badge-info">${escapeHtml(t.sheet)}</span>` : '<span style="color:#cbd5e1;">-</span>'}</td>
            <td>
                <input type="number" min="0" class="form-control threshold-inline-input"
                    value="${escapeHtml(t.threshold)}"
                    onchange="updateThresholdValue('${safeIdAttr}', this.value)">
            </td>
            <td><button type="button" class="btn-refresh" onclick="toggleMarkForDelete('${safeIdAttr}')">${btnLabel}</button></td>
        </tr>
    `;
    }).join('');

    applyThresholdPermissionUI(); // ô/nút vừa được vẽ lại (DOM mới) - phải áp lại khóa quyền ngay, không thì viewer vẫn bấm sửa được
}

// Cho phép sửa thẳng số ngưỡng ngay trong bảng cấu hình - khỏi phải tìm/chọn lại mã từ ô tìm kiếm phía trên
// chỉ để đổi 1 con số. onchange chỉ chạy khi rời khỏi ô (blur/Enter) nên không bị mất focus lúc đang gõ dở.
function updateThresholdValue(id, rawValue) {
    if (!canEditThresholds()) { renderThresholdConfigTable(); return; }
    const val = parseFloat(rawValue);
    if (isNaN(val) || val < 0) {
        showAlert('Ngưỡng cảnh báo phải là số >= 0 nhé anh.', 'error');
        renderThresholdConfigTable(); // nhập sai thì trả ô input về giá trị cũ, tránh lưu nhầm giá trị rác
        return;
    }
    const target = thresholdConfig.find(t => t.id === id);
    if (target) target.threshold = val;
    rebuildThresholdMap();
}

// ---- PANEL GỢI Ý ĐẶT HÀNG LẠI ----

let lastReorderList = []; // lưu lại danh sách đang hiển thị để dùng khi xuất Excel

// Tính danh sách các mã cần đặt hàng lại: chỉ xét những mã đã cấu hình ngưỡng cảnh báo (tab "⚙️ Cảnh báo tồn kho")
// và hiện đang ở trạng thái "sắp hết"/"hết hàng". Sắp xếp mã hết hàng lên trước, trong cùng nhóm thì tỷ lệ
// tồn/ngưỡng càng thấp càng cấp bách, xếp lên trên.
function getReorderList() {
    return thresholdConfig
        .map(t => {
            // Loại trừ sheet "Giá TB" - lý do y hệt processData/syncGhostRows: mọi mã đều có 1 dòng giá bên
            // Giá TB, nếu không loại trừ sẽ vô tình khớp nhầm dòng đó (không có Tồn kho thật) thay vì đúng
            // dòng thuộc danh mục thật hoặc dòng ảo đã tạo cho danh mục đó.
            const item = flatInventoryList.find(i => String(i.id) === String(t.id) && !isPriceSheetName(i.sheet));
            if (!item) return null; // mã đã cấu hình nhưng không còn thấy trong tồn kho hiện tại (VD đổi mã/xóa mã bên Sheet)

            const status = getStockStatus(item);
            if (status === 'normal') return null; // vẫn đủ hàng thì không cần đưa vào danh sách

            // Gợi ý đơn giản: đặt thêm đủ để tồn kho quay lại mức gấp đôi ngưỡng cảnh báo -
            // không dựa trên tốc độ tiêu thụ thực tế vì dữ liệu hiện tại chỉ là số liệu 1 kỳ, chưa đủ để tính xu hướng.
            const suggested = Math.max(0, Math.round(t.threshold * 2 - item.stock));

            return {
                id: item.id,
                name: item.name,
                unit: item.unit,
                stock: item.stock,
                threshold: t.threshold,
                suggested: suggested,
                status: status,
                sheet: item.sheet
            };
        })
        .filter(Boolean)
        .sort((a, b) => {
            if (a.status !== b.status) return a.status === 'out' ? -1 : 1; // hết hàng luôn lên trước sắp hết
            const ratioA = a.threshold > 0 ? a.stock / a.threshold : 0;
            const ratioB = b.threshold > 0 ? b.stock / b.threshold : 0;
            return ratioA - ratioB; // tỷ lệ tồn/ngưỡng càng thấp càng cấp bách
        });
}

function renderReorderPanel() {
    const tbody = document.getElementById('reorderTableBody');
    const countText = document.getElementById('reorder-count-text');
    const list = getReorderList();
    lastReorderList = list;

    countText.innerText = list.length > 0
        ? `⚠️ Có ${list.length} mã đang dưới ngưỡng cảnh báo, cần xem xét đặt hàng lại.`
        : '✅ Không có mã nào đang dưới ngưỡng cảnh báo.';

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="color:#94a3b8; padding:20px;">Không có mã nào đang dưới ngưỡng cảnh báo lúc này.</td></tr>`;
        return;
    }

    tbody.innerHTML = list.map(r => {
        const badge = r.status === 'out'
            ? '<span class="badge badge-danger">Hết hàng</span>'
            : '<span class="badge badge-warning">Sắp hết</span>';
        return `
            <tr>
                <td class="text-left font-bold">${escapeHtml(r.id)}</td>
                <td class="text-left">${escapeHtml(r.name)}</td>
                <td>${escapeHtml(r.unit)}</td>
                <td class="text-right" style="font-weight:bold; color:${getStockColorHex(r.status)};">${r.stock.toLocaleString('en-US')}</td>
                <td class="text-right">${r.threshold.toLocaleString('en-US')}</td>
                <td class="text-right font-bold" style="color:var(--vh-blue);">${r.suggested.toLocaleString('en-US')}</td>
                <td>${badge}</td>
            </tr>
        `;
    }).join('');
}

function exportReorderList() {
    if (!hasPermission('EXPORT_REORDER')) return;
    if (typeof XLSX === 'undefined') {
        showAlert('Không tải được thư viện xuất Excel (có thể do mất mạng). Anh thử tải lại trang rồi bấm lại giúp em.', 'error');
        return;
    }
    if (!lastReorderList || lastReorderList.length === 0) {
        showAlert('Hiện không có mã nào cần đặt hàng lại để xuất.', 'error');
        return;
    }

    const rows = lastReorderList.map(r => ({
        'Mã Vật Tư': r.id,
        'Tên Vật Tư': r.name,
        'ĐVT': r.unit,
        'Tồn Hiện Tại': r.stock,
        'Ngưỡng Cảnh Báo': r.threshold,
        'Gợi Ý Đặt Thêm': r.suggested,
        'Trạng Thái': r.status === 'out' ? 'Hết hàng' : 'Sắp hết',
        'Danh Mục': r.sheet
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Can dat hang lai');

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;

    XLSX.writeFile(workbook, `CanDatHangLai_${timestamp}.xlsx`);
}

// Lưu toàn bộ danh sách cấu hình lên Google Sheet qua Apps Script (doPost) - ghi đè toàn bộ danh sách cũ bằng danh sách hiện tại.
// Đồng thời đây cũng là lúc XÓA THẬT các dòng đang được đánh dấu cam (chờ xóa) - loại hẳn khỏi thresholdConfig
// trước khi gửi đi, để cả web lẫn Google Sheet đồng bộ đúng lúc này.
function saveThresholdConfig() {
    if (!canEditThresholds()) {
        showAlert('Tài khoản của anh/chị không có quyền lưu thay đổi cảnh báo tồn kho.', 'error');
        return;
    }
    const btn = document.getElementById('btn-save-threshold');
    const status = document.getElementById('thresholdSaveStatus');
    btn.disabled = true;
    status.innerText = 'Đang lưu lên Google Sheet...';

    thresholdConfig = thresholdConfig.filter(t => !t.markedForDelete);
    rebuildThresholdMap();
    renderThresholdConfigTable();

    // Dùng Content-Type: text/plain để trình duyệt không gửi preflight OPTIONS (Apps Script không xử lý được request đó),
    // Apps Script vẫn đọc được nội dung JSON gửi lên qua e.postData.contents bình thường.
    fetch(GAS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
            action: 'saveThresholds',
            // Gửi kèm tên/danh mục/đvt (không chỉ mã + ngưỡng) - để nếu sau này kế toán ẩn dòng mã này khỏi
            // Sheet gốc (tồn = 0), Apps Script vẫn lưu lại đủ thông tin cho app dựng lại đúng "dòng ảo".
            thresholds: thresholdConfig.map(t => ({ id: t.id, threshold: t.threshold, name: t.name, sheet: t.sheet, unit: t.unit })),
            token: currentUser.token
        })
    })
        .then(res => res.json())
        .then(data => {
            if (isUnauthorizedResponse(data)) return;
            if (data && data.success) {
                status.innerText = '✅ Đã lưu lúc ' + new Date().toLocaleTimeString('vi-VN');
            } else {
                status.innerText = '❌ Lưu thất bại: ' + (data && data.error ? data.error : 'Không rõ lỗi từ Apps Script');
            }
        })
        .catch(err => {
            console.error('Lỗi khi lưu cấu hình cảnh báo tồn kho:', err);
            status.innerText = '❌ Không lưu được - kiểm tra lại mạng hoặc Apps Script đã deploy bản mới chưa.';
        })
        .finally(() => {
            btn.disabled = false;
        });
}


// ============================================================================
// KHỞI ĐỘNG ỨNG DỤNG
// ----------------------------------------------------------------------------
// Chỉ gọi sau khi TOÀN BỘ file đã được thực thi và mọi biến/hàm phía trên đã được khởi tạo.
// Đây là điểm khởi động duy nhất của app.js.
// ============================================================================
initApp();
