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

function canViewThresholds() { return hasPermission('EDIT_THRESHOLDS'); }
// Hàm tương thích cho code cũ còn sót: Min/Max hiện là read-only nên luôn từ chối thao tác chỉnh sửa.
function canEditThresholds() { return false; }

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
    setVisibleByPermission('btn-open-mrp', 'VIEW_MRP');
    setVisibleByPermission('btn-open-transit', 'VIEW_MRP');
    setVisibleByPermission('btn-toggle-waiting-stock', 'VIEW_MRP');
    setVisibleByPermission('btn-toggle-transit-stock', 'VIEW_MRP');
    setVisibleByPermission('btn-export-inventory', 'EXPORT_INVENTORY');
    setVisibleByPermission('btn-export-reorder', 'EXPORT_REORDER');
    const accountsBtn = document.getElementById('btn-open-accounts');
    if (accountsBtn) accountsBtn.style.display = isAdminUser() ? 'inline-flex' : 'none';
    const stagnantBox = document.getElementById('stagnant-config-box');
    if (stagnantBox) stagnantBox.style.display = hasPermission('EDIT_STAGNANT_CONFIG') ? 'block' : 'none';
    const stagnantInput = document.getElementById('stagnantMonthsInput');
    if (stagnantInput) stagnantInput.value = stagnantMonths;
}

function setVisibleByPermission(id, permission) {
    const el = document.getElementById(id);
    if (el) el.style.display = hasPermission(permission) ? '' : 'none';
}

function toggleAccountDropdown() { document.getElementById('account-dropdown').classList.toggle('open'); }
function populateOwnProfileDepartmentSelect() {
    const select = document.getElementById('profileDepartment');
    if (!select || !currentUser) return;
    const source = departmentList.length ? departmentList : (Array.isArray(registrationOptions.departments) ? registrationOptions.departments : []);
    const current = String(currentUser.department || '').trim();
    const values = source.slice();
    if (current && !values.includes(current)) values.unshift(current);
    select.innerHTML = values.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    if (current) select.value = current;
}

function openOwnProfileEditor() {
    if (!currentUser) return;
    const companyInput = document.getElementById('profileCompanyId');
    const nameInput = document.getElementById('profileFullName');
    const form = document.getElementById('account-profile-form');
    const editBtn = document.getElementById('btn-edit-own-profile');
    if (companyInput) companyInput.value = currentUser.companyId || '';
    if (nameInput) nameInput.value = currentUser.name || '';
    populateOwnProfileDepartmentSelect();
    if (form) form.classList.add('open');
    if (editBtn) editBtn.style.display = 'none';
    companyInput?.focus();
}

function closeOwnProfileEditor() {
    const form = document.getElementById('account-profile-form');
    const editBtn = document.getElementById('btn-edit-own-profile');
    if (form) form.classList.remove('open');
    if (editBtn) editBtn.style.display = '';
}

async function saveOwnProfile() {
    if (!currentUser) return;
    const companyId = String(document.getElementById('profileCompanyId')?.value || '').trim();
    const name = String(document.getElementById('profileFullName')?.value || '').trim();
    const department = String(document.getElementById('profileDepartment')?.value || '').trim();
    if (!companyId || !name || !department) {
        showAlert('Anh/chị nhập đủ Mã ID công ty, Họ và tên và Phòng ban nhé.', 'info');
        return;
    }

    const saveBtn = document.getElementById('btn-save-own-profile');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Đang lưu...'; }
    try {
        const data = await apiPost('updateOwnProfile', { token: currentUser.token, companyId, name, department });
        if (!data || !data.success) {
            if (isUnauthorizedResponse(data)) return handleUnauthorizedSession();
            throw new Error((data && data.error) || 'Không lưu được thông tin.');
        }
        const token = currentUser.token;
        setSessionFromServer(data, token);
        applyLoggedInUI();
        closeOwnProfileEditor();
        showAlert('Đã cập nhật thông tin tài khoản.', 'success');
    } catch (err) {
        showAlert(err.message || 'Không lưu được thông tin. Vui lòng thử lại.', 'error');
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Lưu'; }
    }
}

document.addEventListener('click', function (e) {
    const trigger = document.querySelector('.user-account-trigger');
    const dropdown = document.getElementById('account-dropdown');
    if (trigger && dropdown && !trigger.contains(e.target)) dropdown.classList.remove('open');
});

function applyThresholdPermissionUI() {
    // Min/Max từ nay là dữ liệu chỉ đọc do bộ phận Mua hàng quản lý tại nguồn.
    // Giữ permission EDIT_THRESHOLDS để tương thích ma trận quyền hiện tại, nhưng giao diện không còn thao tác ghi Min/Max.
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
// Min/Max là dữ liệu nghiệp vụ chỉ đọc, đồng bộ từ sheet Canh_bao_ton_kho do bộ phận Mua hàng quản lý.
// Chỉ mã có ít nhất một giá trị Min/Max mới được đưa vào cảnh báo; cả hai trống thì bỏ qua.
// thresholdMap: { [mã vật tư]: { min, max } }. Min/Max có thể độc lập và được phép để trống.
let thresholdConfig = []; // [{ id, name, threshold, maxThreshold, sheet, unit }] - threshold = Min để tương thích phần còn lại của app
let thresholdMap = {};    // tra cứu nhanh khi render bảng chính, key = mã vật tư

// Lọc bảng theo trạng thái cảnh báo: null = không lọc; 'low' = Sắp Hết Hàng; 'out' = Hết Hàng; 'high' = Vượt Mức.
// Áp dụng được ở mọi tab (Dashboard Tổng lẫn từng danh mục con) - không dùng được ở tab Giá TB vì không có khái niệm tồn kho.
let stockFilterMode = null;

function toggleStockFilter(mode) {
    const countIdByMode = { low: 'stat-low', out: 'stat-out', high: 'stat-high' };
    const countEl = document.getElementById(countIdByMode[mode] || '');
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
// Kế toán cho hiện cả mã tồn 0 (gần gấp 3 số mã) -> bảng mặc định ẨN mã tồn 0 cho gọn và nhẹ máy.
// Vẫn luôn hiện: mã tồn 0 CÓ đặt Min (đang báo Hết hàng), mã có hàng đang về khi bật "Cộng đi đường",
// và mã gõ ĐÚNG vào ô tìm kiếm. Các phần cân đối / gợi ý thép tấm vẫn dùng đủ danh sách (cần cả mã tồn 0).
let showZeroStock = false;

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
    thresholdConfig.forEach(t => {
        const min = t.threshold === null || t.threshold === undefined || t.threshold === '' ? null : Number(t.threshold);
        const max = t.maxThreshold === null || t.maxThreshold === undefined || t.maxThreshold === '' ? null : Number(t.maxThreshold);
        thresholdMap[t.id] = {
            min: Number.isFinite(min) ? min : null,
            max: Number.isFinite(max) ? max : null
        };
    });

    syncGhostRows();

    // Mỗi lần tải/làm mới dữ liệu, cập nhật lại thống kê và bảng theo bộ Min/Max mới nhất từ nguồn Mua hàng.
    if (document.getElementById('inventory-table-body')) renderTable();
}

// Đồng bộ "dòng ảo" vào flatInventoryList mỗi khi cấu hình cảnh báo thay đổi - dùng cho mã đã cấu hình
// cảnh báo nhưng bị kế toán ẩn/xóa khỏi Sheet gốc (hoặc mã nhập thủ công chưa từng có trong Sheet).
// Hàm này an toàn gọi lại nhiều lần: luôn dọn sạch dòng ảo cũ trước rồi mới dựng lại từ đầu theo đúng
// thresholdConfig + dữ liệu thật hiện tại, tránh bị sót hoặc bị nhân đôi qua nhiều lần gọi.
function syncGhostRows() {
    flatInventoryList = flatInventoryList.filter(item => !item.isGhost);

    thresholdConfig.forEach(t => {
        // Mã chỉ có Max không cần dựng dòng ảo tồn = 0, vì không có nghiệp vụ cảnh báo thiếu/hết hàng.
        if (t.threshold === null || t.threshold === undefined || t.threshold === '') return;
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
    const limits = thresholdMap[item.id];
    if (limits === undefined) return 'normal'; // không có Min/Max ở nguồn Mua hàng -> bỏ qua cảnh báo

    // Chỉ có Min mới phát sinh cảnh báo thiếu/hết; chỉ có Max thì chỉ theo dõi vượt mức.
    if (limits.min !== null && Number.isFinite(limits.min)) {
        if (item.stock <= 0) return 'out';
        if (item.stock <= limits.min) return 'low';
    }
    if (limits.max !== null && Number.isFinite(limits.max) && item.stock >= limits.max) return 'high';
    return 'normal';
}

function getStockColorHex(status) {
    if (status === 'out') return '#FF8C00';   // cam - hết hàng
    if (status === 'low') return '#ff3b9d';   // hồng tươi - sắp hết hàng, trạng thái cần ưu tiên xử lý
    if (status === 'high') return '#1d4ed8';  // blue đậm - từ ngưỡng Max trở lên
    return '#111827';                         // đen - bình thường hoặc mã chưa cấu hình cảnh báo
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
    on('btn-edit-own-profile', 'click', openOwnProfileEditor);
    on('btn-cancel-own-profile', 'click', closeOwnProfileEditor);
    on('btn-save-own-profile', 'click', saveOwnProfile);
    on('profileFullName', 'keydown', event => { if (event.key === 'Enter') saveOwnProfile(); });
    on('btn-logout', 'click', doLogout);

    on('btn-open-threshold', 'click', openThresholdConfigPanel);
    on('btn-open-reorder', 'click', openReorderPanel);
    on('btn-open-stagnant', 'click', openStagnantPanel);
    bindMrpEvents(on);
    on('btn-open-accounts', 'click', openAccountsPanel);
    on('btn-refresh-data', 'click', refreshData);
    on('btn-pin-toolbar', 'click', toggleStickyToolbar);
    on('btn-close-material360', 'click', closeMaterial360);

    const materialOverlay = document.getElementById('material360-overlay');
    if (materialOverlay) {
        materialOverlay.addEventListener('click', (e) => { if (e.target === materialOverlay) closeMaterial360(); });
    }
    const inventoryBody = document.getElementById('inventory-table-body');
    if (inventoryBody) {
        inventoryBody.addEventListener('click', (e) => {
            const row = e.target.closest('tr[data-material-id]');
            if (!row) return;
            openMaterial360(row.dataset.materialId, row.dataset.materialSheet);
        });
    }
    const dashboard = document.getElementById('dashboard-insights');
    if (dashboard) {
        dashboard.addEventListener('click', (e) => {
            const row = e.target.closest('[data-material-id]');
            if (!row) return;
            openMaterial360(row.dataset.materialId, row.dataset.materialSheet);
        });
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeMaterial360();
    });
    on('initial-dashboard-tab', 'click', function () { filterCategory('ALL', this); });

    on('stat-low-wrap', 'click', () => toggleStockFilter('low'));
    on('stat-out-wrap', 'click', () => toggleStockFilter('out'));
    on('stat-high-wrap', 'click', () => toggleStockFilter('high'));
    // 'input' bắt cả gõ phím lẫn dán bằng chuột (keyup bỏ sót trường hợp dán bằng chuột phải)
    on('searchInput', 'input', renderTable);
    on('btn-toggle-movement', 'click', toggleMovementColumns);
    on('chkShowZero', 'change', (e) => { showZeroStock = e.target.checked; renderTable(); });
    on('btn-toggle-chart', 'click', toggleStockChart);
    on('btn-export-inventory', 'click', exportToExcel);

    on('thresholdCategoryFilterSelect', 'change', event => {
        thresholdCategoryFilter = event.target.value;
        renderThresholdConfigTable();
    });
    on('threshold-sort-id', 'click', () => toggleThresholdSortColumn('id'));
    on('threshold-sort-name', 'click', () => toggleThresholdSortColumn('name'));
    on('btn-save-stagnant', 'click', saveStagnantMonths);

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
    on('btn-export-reorder', 'click', exportReorderList);

    on('btn-close-friendly-alert', 'click', closeFriendlyAlert);
    on('btn-close-friendly-alert-x', 'click', closeFriendlyAlert);
    on('btn-confirm-cancel', 'click', () => closeFriendlyConfirm(false));
    on('btn-confirm-ok', 'click', () => closeFriendlyConfirm(true));
}

// Ghim cụm điều hướng từ thanh đồng bộ đến hết các ô thống kê ngay dưới header.
// Desktop/tablet mặc định ghim; điện thoại <= 600px luôn cuộn tự do để không che nội dung.
function syncStickyToolbarOffset() {
    const header = document.querySelector('.header');
    if (!header) return;
    document.documentElement.style.setProperty('--vhip-header-height', `${Math.ceil(header.getBoundingClientRect().height)}px`);
}

function applyStickyToolbarState() {
    const toolbar = document.getElementById('inventory-sticky-toolbar');
    const button = document.getElementById('btn-pin-toolbar');
    if (!toolbar || !button) return;

    const isMobile = window.matchMedia('(max-width: 600px)').matches;
    let pinned = true;
    try {
        const saved = localStorage.getItem('vhipStickyToolbarPinned');
        if (saved !== null) pinned = saved === '1';
    } catch (_) {}

    // Mobile không ghim bất kể lựa chọn đã lưu từ desktop/tablet.
    const effectivePinned = !isMobile && pinned;
    toolbar.classList.toggle('is-pinned', effectivePinned);
    button.classList.toggle('active', effectivePinned);
    button.innerText = effectivePinned ? '📌 Đang ghim' : '📍 Ghim thanh';
    button.setAttribute('aria-pressed', effectivePinned ? 'true' : 'false');
    button.title = effectivePinned ? 'Bấm để bỏ ghim thanh điều hướng' : 'Bấm để ghim thanh điều hướng';
}

function toggleStickyToolbar() {
    if (window.matchMedia('(max-width: 600px)').matches) return;
    const toolbar = document.getElementById('inventory-sticky-toolbar');
    if (!toolbar) return;
    const nextPinned = !toolbar.classList.contains('is-pinned');
    try { localStorage.setItem('vhipStickyToolbarPinned', nextPinned ? '1' : '0'); } catch (_) {}
    applyStickyToolbarState();
}

function initStickyToolbar() {
    syncStickyToolbarOffset();
    applyStickyToolbarState();
    window.addEventListener('resize', () => {
        syncStickyToolbarOffset();
        applyStickyToolbarState();
    });
}

async function initApp() {
    // app.js được đặt ở cuối <body>, nên toàn bộ DOM đã tồn tại khi hàm này chạy.
    // Bind sự kiện NGAY trước mọi thao tác bất đồng bộ để màn hình đăng nhập luôn bấm được,
    // kể cả khi app-data.json tải chậm hoặc lỗi.
    bindStaticUiEvents();
    initStickyToolbar();

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
                // Số tồn kế toán GỐC - không bao giờ bị đổi. item.stock có thể bị công tắc "Tồn đã trừ chờ xuất" thay.
                accountingStock: parseFloat(item.tonCuoi) || 0,
                tonDau: parseFloat(item.tonDau) || 0,
                nhap: parseFloat(item.nhap) || 0,
                xuat: parseFloat(item.xuat) || 0,
                raw: item // giữ lại dữ liệu gốc của dòng, dùng khi hiển thị sheet Giá TB (khác cấu trúc cột)
            });
        });
    });

    // Nạp Min/Max chỉ đọc từ nguồn Mua hàng. Backend đã bỏ qua mọi dòng có cả Min và Max trống.
    const thresholdsFromServer = data._thresholds || {};
    thresholdConfig = Object.keys(thresholdsFromServer).map(id => {
        const raw = thresholdsFromServer[id] || {};
        const minRaw = raw.threshold;
        const maxRaw = raw.maxThreshold;
        const min = minRaw === null || minRaw === undefined || minRaw === '' ? null : Number(minRaw);
        const max = maxRaw === null || maxRaw === undefined || maxRaw === '' ? null : Number(maxRaw);
        const matchedItem = flatInventoryList.find(i => String(i.id) === String(id) && !isPriceSheetName(i.sheet));

        return {
            id: id,
            name: matchedItem ? matchedItem.name : (raw.name || '(mã chưa có trong dữ liệu tồn kho hiện tại)'),
            sheet: matchedItem ? matchedItem.sheet : (raw.sheet || null),
            unit: matchedItem ? matchedItem.unit : (raw.unit || ''),
            threshold: Number.isFinite(min) ? min : null,
            maxThreshold: Number.isFinite(max) ? max : null
        };
    });
    rebuildThresholdMap();

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

    // Làm mới tồn kho khi đang bật công tắc "Tồn đã trừ chờ xuất" -> áp lại lên dữ liệu mới TRƯỚC khi vẽ bảng.
    if (waitingStockMode) applyWaitingStockMode();

    renderCategoryTabs(realSheetNames);

    // Đang mở tab Vật tư chờ xuất -> tính lại với tồn kho mới (nhu cầu bóc tách không đổi theo tồn kho).
    const mrpPanel = document.getElementById('mrp-panel');
    if (mrpData && mrpPanel && mrpPanel.style.display !== 'none') renderMrpPanel();
    const transitPanel = document.getElementById('transit-panel');
    if (mrpData && transitPanel && transitPanel.style.display !== 'none') renderTransitPanel();

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
        allBtn.dataset.category = 'ALL';
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
        btn.dataset.category = name;
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
    // Bấm bất kỳ tab danh mục nào thì quay thẳng về bảng tồn kho và tắt trạng thái sáng
    // của các tab chức năng Cảnh báo / Cần đặt hàng / Hàng tồn đọng.
    showOnlyPanel('inventory-panel');
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
    // Công tắc tồn kho chờ xuất: vô nghĩa ở tab Giá TB; và chỉ người có quyền mới thấy.
    ['btn-toggle-waiting-stock', 'btn-toggle-transit-stock'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = (isPriceView || !hasPermission('VIEW_MRP')) ? 'none' : '';
    });

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
            <th class="text-right sortable" onclick="toggleSortColumn('value')">${stockColumnLabel()} ${getSortIndicatorHtml('value')}</th>
            ${categoryHeaderCell}
        </tr>`;
}

// Tính khối lượng lý thuyết của 1 tấm thép từ kích thước nằm trong tên vật tư.
// Dùng tích 3 kích thước nên không phụ thuộc thứ tự dày × rộng × dài hay dài × rộng × dày.
// Với tấm tròn dạng D700x115 thì dùng diện tích hình tròn × chiều dày.
// Đơn vị kích thước là mm; khối lượng riêng thép lấy 7.85 t/m³ = 7,850 kg/m³.
function getSteelPlateUnitMassKg(item) {
    const name = String(item && item.name || '').toUpperCase().replace(/,/g, '.');
    const steelDensityFactor = 7.85e-6; // mm³ -> kg đối với thép 7.85 g/cm³

    const roundMatch = name.match(/\bD\s*(\d+(?:\.\d+)?)\s*[X×]\s*(\d+(?:\.\d+)?)/i);
    if (roundMatch) {
        const diameter = Number(roundMatch[1]);
        const thickness = Number(roundMatch[2]);
        if (diameter > 0 && thickness > 0) {
            const volumeMm3 = Math.PI * diameter * diameter / 4 * thickness;
            return volumeMm3 * steelDensityFactor;
        }
    }

    const rectMatch = name.match(/(\d+(?:\.\d+)?)\s*[X×]\s*(\d+(?:\.\d+)?)\s*[X×]\s*(\d+(?:\.\d+)?)/i);
    if (rectMatch) {
        const a = Number(rectMatch[1]);
        const b = Number(rectMatch[2]);
        const c = Number(rectMatch[3]);
        if (a > 0 && b > 0 && c > 0) return a * b * c * steelDensityFactor;
    }

    return null;
}

// Ô Khối Lượng chỉ xuất hiện ở tab THÉP TẤM và luôn phản ánh đúng các dòng đang HIỂN THỊ
// sau tìm kiếm + hashtag + bộ lọc Sắp hết/Hết/Vượt mức. Như vậy đổi bộ lọc là tổng kg đổi ngay.
function updateSteelPlateMassStat(items, isPriceView) {
    const wrap = document.getElementById('stat-mass-wrap');
    const valueEl = document.getElementById('stat-mass');
    if (!wrap || !valueEl) return;

    const isSteelPlate = !isPriceView && String(currentCategory || '').toUpperCase() === 'THÉP TẤM';
    if (!isSteelPlate) {
        wrap.style.display = 'none';
        return;
    }

    let totalKg = 0;
    (items || []).forEach(item => {
        const unitKg = getSteelPlateUnitMassKg(item);
        const quantity = Number(item && item.stock);
        if (unitKg == null || !Number.isFinite(quantity) || quantity <= 0) return;
        totalKg += unitKg * quantity;
    });

    wrap.style.display = 'inline-flex';
    valueEl.innerText = totalKg >= 1000
        ? (totalKg / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' t'
        : totalKg.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' kg';
}


function normalizeUnitForValue(unit) {
    return String(unit == null ? '' : unit).trim().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
        .replace(/\s+/g, '');
}

function getPriceItemForMaterial(item) {
    if (!item) return null;
    return flatInventoryList.find(p => isPriceSheetName(p.sheet) && String(p.id) === String(item.id)) || null;
}

// Chỉ tính giá trị khi đơn vị giá và đơn vị tồn có thể đối chiếu chắc chắn.
// Riêng THÉP TẤM cho phép giá/kg vì app đã tính được khối lượng lý thuyết từ kích thước.
function getInventoryValueInfo(item) {
    const priceItem = getPriceItemForMaterial(item);
    if (!priceItem) return { value: null, price: null, priceUnit: '', basis: '' };
    const price = Number(getPriceValue(priceItem.raw));
    if (!Number.isFinite(price) || price < 0) return { value: null, price: null, priceUnit: priceItem.unit || '', basis: '' };

    const stockUnit = normalizeUnitForValue(item.unit);
    const priceUnit = normalizeUnitForValue(priceItem.unit);
    if (stockUnit && priceUnit && stockUnit === priceUnit) {
        return { value: item.stock * price, price, priceUnit: priceItem.unit || '', basis: 'Theo ĐVT tồn kho' };
    }

    if (String(item.sheet || '').toUpperCase() === 'THÉP TẤM' && ['kg','kilogram'].includes(priceUnit)) {
        const unitKg = getSteelPlateUnitMassKg(item);
        if (unitKg != null) return { value: unitKg * item.stock * price, price, priceUnit: priceItem.unit || 'kg', basis: 'Theo khối lượng lý thuyết' };
    }
    return { value: null, price, priceUnit: priceItem.unit || '', basis: 'Khác ĐVT - chưa quy đổi' };
}

function formatMoneyVnd(value) {
    if (!Number.isFinite(value)) return '—';
    if (value >= 1e9) return (value / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 }) + ' tỷ';
    if (value >= 1e6) return (value / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + ' triệu';
    return Math.round(value).toLocaleString('vi-VN') + ' đ';
}

function formatNumberCompact(value, maxDigits) {
    if (!Number.isFinite(Number(value))) return '—';
    return Number(value).toLocaleString('vi-VN', { maximumFractionDigits: maxDigits == null ? 2 : maxDigits });
}

function getStockStatusLabel(status) {
    return { normal:'Bình thường', low:'Sắp hết', out:'Hết hàng', high:'Vượt mức' }[status] || 'Bình thường';
}

function formatHistoryDate(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';

    // Snapshot cũ có thể được Apps Script trả về dưới dạng chuỗi Date dài kiểu
    // "Fri Oct 09 2026 00:00:00 GMT+0700...". UI chỉ cần ngày nghiệp vụ ngắn gọn.
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
        return d.toLocaleDateString('vi-VN', { day:'2-digit', month:'2-digit', year:'numeric' });
    }

    // Nếu nguồn đã là dd/MM/yyyy thì giữ nguyên, tránh parse nhầm theo chuẩn US.
    const m = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
    if (m) return `${m[1].padStart(2,'0')}/${m[2].padStart(2,'0')}/${m[3]}`;
    return raw;
}

function getMaterialHistory(item) {
    const dates = Array.isArray(stockHistory.dates) ? stockHistory.dates : [];
    const values = stockHistory.data && stockHistory.data[item.id];
    if (!Array.isArray(values)) return [];
    return dates.map((date, i) => ({ date: formatHistoryDate(date), value: values[i] == null ? null : Number(values[i]) }))
        .filter(p => Number.isFinite(p.value));
}

function renderMaterialHistoryChart(points) {
    if (!points.length) return '<div class="material360-note">Chưa có lịch sử snapshot cho mã này hoặc tài khoản hiện tại không có quyền xem lịch sử tồn kho.</div>';
    if (points.length === 1) return `<div class="material360-note">Mới có 1 mốc: <b>${escapeHtml(points[0].date)}</b> — tồn <b>${formatNumberCompact(points[0].value)}</b>.</div>`;

    const width = 620, height = 170, padX = 28, padY = 22;
    const vals = points.map(p => p.value);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (max === min) { max += 1; min = Math.max(0, min - 1); }
    const coords = points.map((p, i) => {
        const x = padX + i * (width - 2 * padX) / Math.max(points.length - 1, 1);
        const y = height - padY - (p.value - min) / (max - min) * (height - 2 * padY);
        return { x, y, p };
    });
    const poly = coords.map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
    const dots = coords.map(c => `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3.5" fill="#2980b9"><title>${escapeHtml(c.p.date)}: ${formatNumberCompact(c.p.value)}</title></circle>`).join('');
    return `<svg class="material360-history-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="Biểu đồ lịch sử tồn kho">
        <line x1="${padX}" y1="${height-padY}" x2="${width-padX}" y2="${height-padY}" stroke="#dbe7ef" stroke-width="1" />
        <polyline points="${poly}" fill="none" stroke="#2980b9" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" />${dots}
    </svg><div class="material360-history-foot"><span>${escapeHtml(points[0].date)}</span><span>${escapeHtml(points[points.length-1].date)}</span></div>`;
}

function openMaterial360(materialId, sheetName) {
    const item = flatInventoryList.find(i => !isPriceSheetName(i.sheet) && String(i.id) === String(materialId) && String(i.sheet) === String(sheetName));
    if (!item) return;
    const overlay = document.getElementById('material360-overlay');
    const body = document.getElementById('material360-body');
    if (!overlay || !body) return;

    document.getElementById('material360-code').textContent = `${item.id} · ${item.sheet}`;
    document.getElementById('material360-name').textContent = item.name || '(Chưa có tên vật tư)';
    const limits = thresholdMap[item.id] || { min:null, max:null };
    const status = getStockStatus(item);
    const valueInfo = getInventoryValueInfo(item);
    const unitKg = String(item.sheet || '').toUpperCase() === 'THÉP TẤM' ? getSteelPlateUnitMassKg(item) : null;
    const totalKg = unitKg == null ? null : unitKg * item.stock;
    const history = getMaterialHistory(item);

    const massMetric = unitKg == null ? '' : `<div class="material360-metric"><div class="material360-metric-label">Khối lượng tồn</div><div class="material360-metric-value">${totalKg >= 1000 ? formatNumberCompact(totalKg/1000) + ' t' : formatNumberCompact(totalKg,0) + ' kg'}</div></div>`;
    const valueMetric = `<div class="material360-metric"><div class="material360-metric-label">Giá trị tồn</div><div class="material360-metric-value">${formatMoneyVnd(valueInfo.value)}</div></div>`;
    const priceText = valueInfo.price == null ? 'Chưa có giá phù hợp' : `${formatNumberCompact(valueInfo.price,0)} đ/${escapeHtml(valueInfo.priceUnit || item.unit || '')}`;

    body.innerHTML = `
        <div class="material360-grid">
            <div class="material360-metric"><div class="material360-metric-label">Tồn hiện tại</div><div class="material360-metric-value">${formatNumberCompact(item.stock)} ${escapeHtml(item.unit)}</div></div>
            <div class="material360-metric"><div class="material360-metric-label">Trạng thái</div><div class="material360-metric-value"><span class="status-chip ${status}">${getStockStatusLabel(status)}</span></div></div>
            <div class="material360-metric"><div class="material360-metric-label">Min / Max</div><div class="material360-metric-value">${limits.min == null ? '—' : formatNumberCompact(limits.min)} / ${limits.max == null ? '—' : formatNumberCompact(limits.max)}</div></div>
            ${massMetric || valueMetric}
            ${massMetric ? valueMetric : ''}
        </div>
        <div class="material360-section-grid">
            <div class="material360-section">
                <div class="material360-section-title">📦 Biến động kỳ hiện tại</div>
                <div class="material360-flow">
                    <div class="material360-flow-item"><div class="material360-flow-label">Tồn đầu</div><div class="material360-flow-value">${formatNumberCompact(item.tonDau)}</div></div>
                    <div class="material360-flow-item"><div class="material360-flow-label">Nhập</div><div class="material360-flow-value" style="color:#15803d">+${formatNumberCompact(item.nhap)}</div></div>
                    <div class="material360-flow-item"><div class="material360-flow-label">Xuất</div><div class="material360-flow-value" style="color:#c2410c">-${formatNumberCompact(item.xuat)}</div></div>
                    <div class="material360-flow-item"><div class="material360-flow-label">Tồn cuối</div><div class="material360-flow-value">${formatNumberCompact(item.stock)}</div></div>
                </div>
            </div>
            <div class="material360-section">
                <div class="material360-section-title">💰 Giá & khối lượng</div>
                <div class="material360-note">
                    <div><b>Giá TB:</b> ${priceText}</div>
                    ${unitKg == null ? '' : `<div style="margin-top:6px"><b>KL lý thuyết / tấm:</b> ${formatNumberCompact(unitKg,1)} kg</div>`}
                    <div style="margin-top:6px"><b>Cơ sở tính giá trị:</b> ${escapeHtml(valueInfo.basis || 'Chưa đủ dữ liệu để đối chiếu ĐVT')}</div>
                    <div style="margin-top:6px"><b>Giá trị tồn:</b> ${formatMoneyVnd(valueInfo.value)}</div>
                </div>
            </div>
        </div>
        <div class="material360-section">
            <div class="material360-section-title">📈 Lịch sử tồn kho</div>
            ${renderMaterialHistoryChart(history)}
        </div>`;

    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
}

function closeMaterial360() {
    const overlay = document.getElementById('material360-overlay');
    if (!overlay || !overlay.classList.contains('open')) return;
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
}

function renderDashboardInsights(items, isPriceView) {
    const wrap = document.getElementById('dashboard-insights');
    if (!wrap) return;
    const show = currentCategory === 'ALL' && !isPriceView;
    wrap.classList.toggle('visible', show);
    if (!show) { wrap.innerHTML = ''; return; }

    // Dashboard chỉ tổng hợp từ dữ liệu đã tải vào RAM. Không gọi API phụ để việc mở Dashboard tức thời.
    const valued = items.map(item => ({ item, info:getInventoryValueInfo(item) })).filter(x => Number.isFinite(x.info.value));
    const totalValue = valued.reduce((sum,x) => sum + x.info.value, 0);
    const valuedMap = new Map(valued.map(x => [`${x.item.sheet}|${x.item.id}`, x.info]));

    let steelKg = 0;
    items.forEach(item => {
        if (String(item.sheet || '').toUpperCase() !== 'THÉP TẤM') return;
        const unitKg = getSteelPlateUnitMassKg(item);
        if (unitKg != null && Number.isFinite(Number(item.stock)) && Number(item.stock) > 0) steelKg += unitKg * Number(item.stock);
    });

    const categoryValues = {};
    valued.forEach(x => { categoryValues[x.item.sheet] = (categoryValues[x.item.sheet] || 0) + x.info.value; });
    const categoryRows = Object.entries(categoryValues).sort((a,b)=>b[1]-a[1]);
    const maxCategory = categoryRows.length ? categoryRows[0][1] : 1;
    const categoryHtml = categoryRows.length
        ? categoryRows.map(([name,value]) => `<div class="dashboard-bar-row"><div class="dashboard-bar-label" title="${escapeHtml(name)}">${escapeHtml(name)}</div><div class="dashboard-bar-track"><div class="dashboard-bar-fill" style="width:${Math.max(2,value/maxCategory*100)}%"></div></div><div class="dashboard-bar-value">${formatMoneyVnd(value)}</div></div>`).join('')
        : '<div class="material360-note">Chưa đủ dữ liệu giá/ĐVT để tính giá trị theo danh mục.</div>';

    // Biểu đồ donut dùng cùng dữ liệu giá trị theo danh mục với biểu đồ thanh để hai góc nhìn luôn khớp nhau.
    // Dùng conic-gradient thuần CSS nên không cần thêm thư viện chart, giữ app nhẹ và chạy tốt trên GitHub Pages.
    const categoryPieColors = ['#2980b9','#27ae60','#f59e0b','#8b5cf6','#ec4899','#14b8a6','#64748b','#ef4444'];
    let pieCursor = 0;
    const pieStops = [];
    const pieLegend = [];
    if (categoryRows.length && totalValue > 0) {
        categoryRows.forEach(([name,value], index) => {
            const pct = value / totalValue * 100;
            const start = pieCursor;
            pieCursor += pct;
            const color = categoryPieColors[index % categoryPieColors.length];
            pieStops.push(`${color} ${start.toFixed(4)}% ${pieCursor.toFixed(4)}%`);
            pieLegend.push(`<div class="dashboard-pie-legend-row"><span class="dashboard-pie-dot" style="background:${color}"></span><span class="dashboard-pie-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span><span class="dashboard-pie-percent">${pct.toLocaleString('vi-VN',{maximumFractionDigits:1})}%</span><span class="dashboard-pie-value">${formatMoneyVnd(value)}</span></div>`);
        });
    }
    const categoryPieHtml = pieStops.length
        ? `<div class="dashboard-pie-layout"><div class="dashboard-pie-wrap"><div class="dashboard-pie" style="background:conic-gradient(${pieStops.join(',')})"><div class="dashboard-pie-hole"><strong>100%</strong><span>Giá trị tồn</span></div></div></div><div class="dashboard-pie-legend">${pieLegend.join('')}</div></div>`
        : '<div class="material360-note">Chưa đủ dữ liệu giá/ĐVT để tính tỷ trọng giá trị tồn.</div>';

    const topValue = valued.slice().sort((a,b)=>b.info.value-a.info.value).slice(0,8);
    const topHtml = topValue.length
        ? topValue.map(x => `<div class="dashboard-list-row" data-material-id="${escapeHtml(x.item.id)}" data-material-sheet="${escapeHtml(x.item.sheet)}"><div><div class="dashboard-list-name">${escapeHtml(x.item.name)}</div><div class="dashboard-list-code">${escapeHtml(x.item.id)} · ${escapeHtml(x.item.sheet)}</div></div><div class="dashboard-list-value">${formatMoneyVnd(x.info.value)}</div></div>`).join('')
        : '<div class="material360-note">Chưa đủ dữ liệu để xếp hạng giá trị tồn.</div>';

    // Khối "Mã vượt ngưỡng tồn kho" chỉ lấy các mã có Min/Max được cấu hình thật.
    // Mỗi nhóm lấy tối đa 10 mã và xếp theo khoảng cách tuyệt đối tới ngưỡng để Dashboard ưu tiên
    // đúng các trường hợp lệch mạnh nhất, đồng thời không để một nhóm chiếm hết danh sách.
    const thresholdRows = items.map(item => {
        const limits = thresholdMap[item.id];
        if (!limits) return null;
        const stock = Number(item.stock);
        if (!Number.isFinite(stock)) return null;
        const min = limits.min !== null && Number.isFinite(Number(limits.min)) ? Number(limits.min) : null;
        const max = limits.max !== null && Number.isFinite(Number(limits.max)) ? Number(limits.max) : null;
        return { item, stock, min, max };
    }).filter(Boolean);

    const attentionOut = thresholdRows
        .filter(x => x.min !== null && x.stock <= 0)
        .map(x => ({ ...x, gap:x.min - x.stock, status:'out' }))
        .sort((a,b) => b.gap - a.gap)
        .slice(0,10);

    const attentionLow = thresholdRows
        .filter(x => x.min !== null && x.stock > 0 && x.stock < x.min)
        .map(x => ({ ...x, gap:x.min - x.stock, status:'low' }))
        .sort((a,b) => b.gap - a.gap)
        .slice(0,10);

    const attentionHigh = thresholdRows
        .filter(x => x.max !== null && x.stock > x.max)
        .map(x => ({ ...x, gap:x.stock - x.max, status:'high' }))
        .sort((a,b) => b.gap - a.gap)
        .slice(0,10);

    const renderAttentionGroup = (title, rows, type) => {
        if (!rows.length) return `<div class="dashboard-alert-group"><div class="dashboard-alert-group-title ${type}">${title}</div><div class="material360-note">Không có mã trong nhóm này.</div></div>`;
        return `<div class="dashboard-alert-group"><div class="dashboard-alert-group-title ${type}">${title} <span>${rows.length}</span></div>${rows.map(x => {
            const i = x.item;
            const thresholdText = type === 'high'
                ? `Max ${formatNumberCompact(x.max)} · Vượt ${formatNumberCompact(x.gap)} ${escapeHtml(i.unit)}`
                : `Min ${formatNumberCompact(x.min)} · Thiếu ${formatNumberCompact(x.gap)} ${escapeHtml(i.unit)}`;
            return `<div class="dashboard-list-row" data-material-id="${escapeHtml(i.id)}" data-material-sheet="${escapeHtml(i.sheet)}"><div><div class="dashboard-list-name">${escapeHtml(i.name)}</div><div class="dashboard-list-code">${escapeHtml(i.id)} · ${escapeHtml(i.sheet)} · Tồn ${formatNumberCompact(x.stock)} ${escapeHtml(i.unit)} · ${thresholdText}</div></div><div class="dashboard-list-value"><span class="status-chip ${x.status}">${getStockStatusLabel(x.status)}</span></div></div>`;
        }).join('')}</div>`;
    };

    const attentionHtml = [
        renderAttentionGroup('⛔ Hết hàng có Min', attentionOut, 'out'),
        renderAttentionGroup('⚠️ Dưới Min', attentionLow, 'low'),
        renderAttentionGroup('⬆️ Vượt Max', attentionHigh, 'high')
    ].join('');

    const stagnant = typeof getStagnantList === 'function' ? getStagnantList() : {notEnoughData:true,items:[]};
    const stagnantText = stagnant.notEnoughData ? `Chưa đủ ${stagnant.needed || stagnantMonths} mốc` : `${stagnant.items.length} mã`;
    const stagnantValued = stagnant.notEnoughData ? [] : stagnant.items.map(s => {
        const item = items.find(i => String(i.id) === String(s.id) && String(i.sheet) === String(s.sheet));
        if (!item) return null;
        const info = valuedMap.get(`${item.sheet}|${item.id}`) || getInventoryValueInfo(item);
        return { item, info, months:s.months };
    }).filter(x => x && Number.isFinite(x.info.value)).sort((a,b)=>b.info.value-a.info.value).slice(0,8);
    const stagnantValueTotal = stagnant.notEnoughData ? null : stagnant.items.reduce((sum,s) => {
        const item = items.find(i => String(i.id) === String(s.id) && String(i.sheet) === String(s.sheet));
        if (!item) return sum;
        const info = valuedMap.get(`${item.sheet}|${item.id}`) || getInventoryValueInfo(item);
        return Number.isFinite(info.value) ? sum + info.value : sum;
    }, 0);
    const stagnantHtml = stagnant.notEnoughData
        ? `<div class="material360-note">Chưa đủ ${stagnant.have || 0}/${stagnant.needed || stagnantMonths} mốc snapshot để kết luận hàng tồn đọng.</div>`
        : (stagnantValued.length
            ? stagnantValued.map(x => `<div class="dashboard-list-row" data-material-id="${escapeHtml(x.item.id)}" data-material-sheet="${escapeHtml(x.item.sheet)}"><div><div class="dashboard-list-name">${escapeHtml(x.item.name)}</div><div class="dashboard-list-code">${escapeHtml(x.item.id)} · ${escapeHtml(x.item.sheet)} · ${x.months} tháng không đổi</div></div><div class="dashboard-list-value">${formatMoneyVnd(x.info.value)}</div></div>`).join('')
            : '<div class="material360-note">Chưa có hàng tồn đọng nào có đủ dữ liệu giá để xếp theo giá trị.</div>');

    const statusCounts = { normal:0, low:0, out:0, high:0 };
    items.forEach(i => { const s=getStockStatus(i); if (statusCounts[s] != null) statusCounts[s]++; });
    const maxStatus = Math.max(1, ...Object.values(statusCounts));
    const statusHtml = [
        ['normal','Bình thường'], ['low','Sắp hết'], ['out','Hết hàng'], ['high','Vượt mức']
    ].map(([key,label]) => `<div class="dashboard-status-row"><div class="dashboard-status-label">${label}</div><div class="dashboard-status-track"><div class="dashboard-status-fill ${key}" style="width:${statusCounts[key] ? Math.max(2,statusCounts[key]/maxStatus*100) : 0}%"></div></div><div class="dashboard-status-value">${statusCounts[key]}</div></div>`).join('');

    const steelMassText = steelKg >= 1000
        ? `${formatNumberCompact(steelKg/1000,2)} t`
        : `${formatNumberCompact(steelKg,0)} kg`;

    wrap.innerHTML = `<div class="dashboard-insights-head"><div><div class="dashboard-insights-title">📊 Tổng quan quản trị tồn kho</div><div class="dashboard-insights-sub">Nhìn tổng thể trước, bấm một vật tư để mở Material 360 và xem nguyên nhân chi tiết.</div></div></div>
        <div class="dashboard-kpi-grid">
            <div class="dashboard-kpi"><div class="dashboard-kpi-label">Giá trị tồn tính được</div><div class="dashboard-kpi-value">${formatMoneyVnd(totalValue)}</div><div class="dashboard-kpi-note">Tính được ${valued.length}/${items.length} mã có giá và ĐVT đối chiếu được.</div></div>
            <div class="dashboard-kpi"><div class="dashboard-kpi-label">Khối lượng thép tấm</div><div class="dashboard-kpi-value">${steelMassText}</div><div class="dashboard-kpi-note">Khối lượng lý thuyết của toàn bộ thép tấm đang có tồn.</div></div>
            <div class="dashboard-kpi"><div class="dashboard-kpi-label">Hàng tồn đọng</div><div class="dashboard-kpi-value small">${stagnantText}</div><div class="dashboard-kpi-note">${stagnantValueTotal == null ? `Theo ngưỡng ${stagnantMonths} tháng snapshot hiện tại.` : `Giá trị tính được: ${formatMoneyVnd(stagnantValueTotal)}.`}</div></div>
        </div>
        <div class="dashboard-grid">
            <div class="dashboard-card"><div class="dashboard-card-title">💰 Giá trị tồn theo danh mục</div>${categoryHtml}</div>
            <div class="dashboard-card"><div class="dashboard-card-title">🥧 Tỷ trọng giá trị tồn theo danh mục</div>${categoryPieHtml}</div>
            <div class="dashboard-card"><div class="dashboard-card-title">📌 Cơ cấu trạng thái tồn kho</div>${statusHtml}</div>
            <div class="dashboard-card"><div class="dashboard-card-title">🏆 Top vật tư theo giá trị tồn</div>${topHtml}</div>
            <div class="dashboard-card"><div class="dashboard-card-title">📦 Hàng tồn đọng giá trị lớn</div>${stagnantHtml}</div>
            <div class="dashboard-card" style="grid-column:1/-1"><div class="dashboard-card-title">⚠️ Mã vượt ngưỡng tồn kho</div><div class="dashboard-alert-groups">${attentionHtml}</div></div>
        </div>`;
}

// Ô "Số mã": số mã đang hiện; khi đang ẩn mã tồn 0 thì ghi thêm "/ tổng" (kể cả mã tồn 0) để khỏi hiểu nhầm.
function setStatTotal(shown, scopeTotal, isPriceView) {
    const el = document.getElementById('stat-total');
    if (!el) return;
    const hiding = !isPriceView && !showZeroStock && scopeTotal > shown;
    el.innerHTML = hiding
        ? `${shown.toLocaleString('en-US')}<span class="stat-bar-sub"> / ${scopeTotal.toLocaleString('en-US')}</span>`
        : shown.toLocaleString('en-US');
    el.title = hiding ? `${shown} mã đang hiện (có tồn hoặc đang cảnh báo) / ${scopeTotal} mã kể cả tồn 0` : '';
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
    const scopeCount = baseFilteredData.length;   // kể cả mã tồn 0 - để ô Số mã ghi "có tồn / tổng"
    if (!isPriceView && !showZeroStock) {
        const keep = item => accountingStockOf(item) > 0 || item.stock > 0 || getStockStatus(item) !== 'normal'
            || (searchTerm && String(item.id == null ? '' : item.id).toLowerCase() === searchTerm.trim());
        for (let i = baseFilteredData.length - 1; i >= 0; i--) if (!keep(baseFilteredData[i])) baseFilteredData.splice(i, 1);
    }
    const zeroWrap = document.getElementById('wrap-show-zero');
    if (zeroWrap) zeroWrap.style.display = isPriceView ? 'none' : '';

    // Dashboard Tổng dùng đúng tập dữ liệu sau tìm kiếm/hashtag nhưng không phụ thuộc bộ lọc trạng thái đang bấm.
    renderDashboardInsights(baseFilteredData, isPriceView);

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

    // Hết hàng luôn đặt xuống CUỐI danh sách để các mã còn tồn được ưu tiên theo dõi trước.
    // Tách rồi ghép lại thay vì sort thêm lần nữa để giữ nguyên thứ tự hiện tại của từng nhóm
    // (kể cả khi anh vừa sort theo Tên Vật Tư hoặc Tồn Kho).
    if (!isPriceView) {
        const availableRows = [];
        const outRows = [];
        filteredData.forEach(item => {
            if (getStockStatus(item) === 'out') outRows.push(item);
            else availableRows.push(item);
        });
        filteredData.splice(0, filteredData.length, ...availableRows, ...outRows);
    }

    const showMovement = showMovementColumns && !isPriceView;
    const showCategoryColumn = currentCategory === 'ALL';
    const totalColumns = isPriceView ? 5 : (4 + (showMovement ? 3 : 0) + (showCategoryColumn ? 1 : 0));

    if (filteredData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${totalColumns}" style="color:#94a3b8; padding:20px;">Không tìm thấy vật tư phù hợp.${!isPriceView && !showZeroStock && scopeCount ? ' Có thể mã đang tồn 0 – tích "Hiện cả mã tồn 0" để xem.' : ''}</td></tr>`;
        setStatTotal(0, scopeCount, isPriceView);
        updateSteelPlateMassStat(filteredData, isPriceView);
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
            const rowClass = status === 'low' ? 'stock-row-low' : status === 'out' ? 'stock-row-out' : status === 'high' ? 'stock-row-high' : '';
            return `
            <tr class="${rowClass} material-row" data-material-id="${escapeHtml(item.id)}" data-material-sheet="${escapeHtml(item.sheet)}" title="Bấm để xem chi tiết vật tư">
                <td class="text-left font-bold">${escapeHtml(item.id)}</td>
                <td class="text-left">${nameCell}</td>
                <td>${escapeHtml(item.unit)}</td>
                ${movementCells}
                <td class="text-right" style="font-weight:bold; font-size:15px; color:${stockColor};">${item.stock.toLocaleString('en-US')}${
                    (item.waiting || item.transit) ? `<div class="waiting-note" title="Tồn kế toán − chờ xuất + đi đường">KT ${item.accountingStock.toLocaleString('en-US')}${item.waiting ? ' − chờ ' + formatMrpQty(item.waiting) : ''}${item.transit ? ' + về ' + formatMrpQty(item.transit) : ''}</div>` : ''}</td>
                ${categoryCell}
            </tr>
        `;
        });
        tbody.innerHTML = rowsHtml.join('');
    }

    setStatTotal(filteredData.length, scopeCount, isPriceView);
    updateSteelPlateMassStat(filteredData, isPriceView);
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

// Cập nhật 3 ô cảnh báo Min / Hết hàng / Max theo đúng dữ liệu đang hiển thị (đã lọc theo tab/tìm kiếm/hashtag).
// Tab "Giá TB" không có khái niệm tồn kho nên ẩn cả 3 ô này đi.
function updateStockWarningStats(items, isPriceView) {
    const lowWrap = document.getElementById('stat-low-wrap');
    const outWrap = document.getElementById('stat-out-wrap');
    const highWrap = document.getElementById('stat-high-wrap');
    if (!lowWrap || !outWrap || !highWrap) return;

    if (isPriceView) {
        lowWrap.style.display = 'none';
        outWrap.style.display = 'none';
        highWrap.style.display = 'none';
        return;
    }

    let lowCount = 0;
    let outCount = 0;
    let highCount = 0;
    items.forEach(item => {
        const status = getStockStatus(item);
        if (status === 'low') lowCount++;
        else if (status === 'out') outCount++;
        else if (status === 'high') highCount++;
    });

    document.getElementById('stat-low').innerText = lowCount;
    document.getElementById('stat-out').innerText = outCount;
    document.getElementById('stat-high').innerText = highCount;
    lowWrap.style.display = '';
    outWrap.style.display = '';
    highWrap.style.display = '';

    // Bấm được (đổi con trỏ + hover) chỉ khi count > 0; bằng 0 thì làm mờ nhẹ, bấm không có tác dụng
    lowWrap.classList.toggle('clickable', lowCount > 0);
    lowWrap.classList.toggle('not-clickable', lowCount === 0);
    outWrap.classList.toggle('clickable', outCount > 0);
    outWrap.classList.toggle('not-clickable', outCount === 0);
    highWrap.classList.toggle('clickable', highCount > 0);
    highWrap.classList.toggle('not-clickable', highCount === 0);

    // Tô đậm ô đang được dùng để lọc bảng. Mỗi thời điểm chỉ có một trạng thái được lọc.
    lowWrap.classList.toggle('active-filter', stockFilterMode === 'low');
    outWrap.classList.toggle('active-filter', stockFilterMode === 'out');
    highWrap.classList.toggle('active-filter', stockFilterMode === 'high');
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
            if (waitingStockMode || transitStockMode) {
                // Xuất rõ từng con số để người nhận file không nhầm tồn đã điều chỉnh với tồn kế toán.
                row['Tồn Kế Toán'] = item.accountingStock;
                if (waitingStockMode) row['Chờ Xuất'] = item.waiting || 0;
                if (transitStockMode) row['Đi Đường'] = item.transit || 0;
                row[stockColumnLabel()] = item.stock;
            } else {
                row['Tồn Kho'] = item.stock;
            }
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
const ALL_PANEL_IDS = ['inventory-panel', 'threshold-config-panel', 'reorder-panel', 'accounts-panel', 'stagnant-panel', 'mrp-panel', 'transit-panel'];

// Hiển thị đúng một panel và đồng bộ trạng thái sáng của 3 tab chức năng phía trên.
// Làm như vậy để người dùng luôn biết mình đang đứng ở màn nào và có thể chuyển thẳng bằng tab,
// không cần thêm nút "Quay lại" trong từng panel.
function showOnlyPanel(panelIdToShow) {
    ALL_PANEL_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = (id === panelIdToShow) ? 'block' : 'none';
    });

    const panelButtonMap = {
        'threshold-config-panel': 'btn-open-threshold',
        'reorder-panel': 'btn-open-reorder',
        'stagnant-panel': 'btn-open-stagnant',
        'mrp-panel': 'btn-open-mrp',
        'transit-panel': 'btn-open-transit'
    };
    ['btn-open-threshold', 'btn-open-reorder', 'btn-open-stagnant', 'btn-open-mrp', 'btn-open-transit'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.toggle('active', panelButtonMap[panelIdToShow] === id);
    });

    // Hai hàng nút cùng đóng vai trò điều hướng màn hình nên tại một thời điểm chỉ để 1 tab sáng.
    // Khi mở Cảnh báo/Cần đặt/Hàng tồn đọng/Quản lý, bỏ sáng tab danh mục; khi quay lại bảng tồn kho,
    // khôi phục đúng danh mục đang xem để người dùng không mất ngữ cảnh.
    document.querySelectorAll('.nav-tab-btn').forEach(btn => {
        const shouldBeActive = panelIdToShow === 'inventory-panel' && btn.dataset.category === currentCategory;
        btn.classList.toggle('active', shouldBeActive);
    });
}

function openThresholdConfigPanel() {
    // Giữ permission hiện tại để không làm xáo trộn ma trận quyền; panel Min/Max bên trong là chỉ đọc.
    if (!canViewThresholds()) return;
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
            💡 Dựa trên dữ liệu chụp tồn kho tự động mỗi đầu tháng. Ngưỡng ${stagnantMonths} tháng do quản trị viên đặt (chỉnh ở tab 📦 Hàng Tồn Đọng).
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
            <td class="text-left">${escapeHtml(acc.companyId || '-')}</td>
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
    const targetAccount = accountsList.find(a => a.userId === userId);
    // Mã ID công ty do người dùng tự quản lý trong hồ sơ cá nhân; bảng Admin chỉ hiển thị để tránh hai nơi cùng sửa một dữ liệu.
    const companyId = targetAccount ? String(targetAccount.companyId || '').trim() : '';
    const role = row.querySelector('.account-role-select').value;
    const statusValue = row.querySelector('.account-status-select').value;
    const status = document.getElementById('accountsSaveStatus');
    const isCompanyIdChange = false;
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

    if (control.classList.contains('account-role-select') || control.classList.contains('account-status-select')) {
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
    const maxInput = document.getElementById('thresholdMaxValueInput').value.trim();
    const maxThresholdVal = maxInput === '' ? null : parseFloat(maxInput);
    if (isNaN(thresholdVal) || thresholdVal < 0) {
        showAlert('Anh nhập Min là 1 số >= 0 nhé.', 'error');
        return;
    }
    if (maxThresholdVal !== null && (isNaN(maxThresholdVal) || maxThresholdVal < 0)) {
        showAlert('Max phải là 1 số >= 0 hoặc để trống nhé anh.', 'error');
        return;
    }
    if (maxThresholdVal !== null && maxThresholdVal < thresholdVal) {
        showAlert('Max phải lớn hơn hoặc bằng Min nhé anh.', 'error');
        return;
    }

    const existing = thresholdConfig.find(t => t.id === pendingThresholdItem.id);
    if (existing) {
        existing.threshold = thresholdVal; // Min
        existing.maxThreshold = maxThresholdVal; // Max có thể để trống
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
            threshold: thresholdVal,
            maxThreshold: maxThresholdVal
        });
    }

    document.getElementById('thresholdSearchInput').value = '';
    document.getElementById('thresholdValueInput').value = '';
    document.getElementById('thresholdMaxValueInput').value = '';
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
    if (!tbody) return;

    renderThresholdCategoryFilterOptions();
    updateThresholdSortArrows();

    let list = thresholdCategoryFilter
        ? thresholdConfig.filter(t => t.sheet === thresholdCategoryFilter)
        : thresholdConfig.slice();

    if (thresholdSortState.column) {
        const dir = thresholdSortState.direction === 'asc' ? 1 : -1;
        const field = thresholdSortState.column;
        list.sort((a, b) => String(a[field] || '').localeCompare(String(b[field] || ''), 'vi', { numeric: true }) * dir);
    }

    const countText = document.getElementById('threshold-count-text');
    if (countText) countText.textContent = `Đang hiển thị ${list.length.toLocaleString('vi-VN')} / ${thresholdConfig.length.toLocaleString('vi-VN')} mã có cấu hình Min/Max.`;

    if (list.length === 0) {
        const emptyMsg = thresholdConfig.length === 0
            ? 'Hiện chưa có mã nào có Min hoặc Max trong dữ liệu cảnh báo từ bộ phận Mua hàng.'
            : `Không có mã nào thuộc danh mục "${escapeHtml(thresholdCategoryFilter)}" trong danh sách cảnh báo.`;
        tbody.innerHTML = `<tr><td colspan="6" style="color:#94a3b8; padding:16px;">${emptyMsg}</td></tr>`;
        return;
    }

    tbody.innerHTML = list.map(t => `
        <tr>
            <td class="text-left font-bold">${escapeHtml(t.id)}</td>
            <td class="text-left">${escapeHtml(t.name)}</td>
            <td class="text-left">${t.sheet ? `<span class="badge badge-info">${escapeHtml(t.sheet)}</span>` : '<span style="color:#cbd5e1;">-</span>'}</td>
            <td>${t.unit ? escapeHtml(t.unit) : '<span style="color:#cbd5e1;">-</span>'}</td>
            <td class="text-right font-bold">${t.threshold === null || t.threshold === undefined ? '<span style="color:#cbd5e1;">-</span>' : Number(t.threshold).toLocaleString('en-US')}</td>
            <td class="text-right font-bold">${t.maxThreshold === null || t.maxThreshold === undefined ? '<span style="color:#cbd5e1;">-</span>' : Number(t.maxThreshold).toLocaleString('en-US')}</td>
        </tr>
    `).join('');
}

// Cho phép sửa thẳng số ngưỡng ngay trong bảng cấu hình - khỏi phải tìm/chọn lại mã từ ô tìm kiếm phía trên
// chỉ để đổi 1 con số. onchange chỉ chạy khi rời khỏi ô (blur/Enter) nên không bị mất focus lúc đang gõ dở.
function updateThresholdValue(id, kind, rawValue) {
    if (!canEditThresholds()) { renderThresholdConfigTable(); return; }
    const target = thresholdConfig.find(t => t.id === id);
    if (!target) return;

    if (kind === 'max' && String(rawValue).trim() === '') {
        target.maxThreshold = null;
        rebuildThresholdMap();
        return;
    }

    const val = parseFloat(rawValue);
    if (isNaN(val) || val < 0) {
        showAlert((kind === 'max' ? 'Max' : 'Min') + ' phải là số >= 0 nhé anh.', 'error');
        renderThresholdConfigTable();
        return;
    }

    if (kind === 'max') {
        if (val < Number(target.threshold || 0)) {
            showAlert('Max phải lớn hơn hoặc bằng Min nhé anh.', 'error');
            renderThresholdConfigTable();
            return;
        }
        target.maxThreshold = val;
    } else {
        if (target.maxThreshold !== null && target.maxThreshold !== undefined && Number(target.maxThreshold) < val) {
            showAlert('Min không được lớn hơn Max nhé anh.', 'error');
            renderThresholdConfigTable();
            return;
        }
        target.threshold = val;
    }
    rebuildThresholdMap();
}

// ---- PANEL GỢI Ý ĐẶT HÀNG LẠI ----

let lastReorderList = []; // lưu lại danh sách đang hiển thị để dùng khi xuất Excel

// Tính danh sách cần đặt hàng: chỉ xét mã có Min từ nguồn Mua hàng và đang ở trạng thái sắp hết/hết hàng. Sắp xếp mã hết hàng lên trước, trong cùng nhóm thì tỷ lệ
// tồn/ngưỡng càng thấp càng cấp bách, xếp lên trên.
function getReorderList() {
    return thresholdConfig
        .filter(t => t.threshold !== null && t.threshold !== undefined && t.threshold !== '')
        .map(t => {
            // Loại trừ sheet "Giá TB" - lý do y hệt processData/syncGhostRows: mọi mã đều có 1 dòng giá bên
            // Giá TB, nếu không loại trừ sẽ vô tình khớp nhầm dòng đó (không có Tồn kho thật) thay vì đúng
            // dòng thuộc danh mục thật hoặc dòng ảo đã tạo cho danh mục đó.
            const item = flatInventoryList.find(i => String(i.id) === String(t.id) && !isPriceSheetName(i.sheet));
            if (!item) return null; // mã đã cấu hình nhưng không còn thấy trong tồn kho hiện tại (VD đổi mã/xóa mã bên Sheet)

            const status = getStockStatus(item);
            if (status !== 'low' && status !== 'out') return null; // Max/vượt mức không phải nhu cầu đặt hàng

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
    showAlert('Min/Max hiện là dữ liệu chỉ đọc từ bộ phận Mua hàng; chương trình không ghi thay đổi vào nguồn này.', 'info');
}



// ============================================================================
// VẬT TƯ CHỜ XUẤT + VẬT TƯ ĐI ĐƯỜNG + CÔNG TẮC TỒN KHO
// ----------------------------------------------------------------------------
// Vòng đời vật tư của 1 đơn:  Chưa xử lý  ->  Chờ xuất  ->  Đã xuất
//   - Đơn mới từ bóc tách = Chưa xử lý: KHÔNG tác động gì.
//   - Trưởng phòng tích đơn vào Chờ xuất (cộng dồn qua các ngày): toàn bộ vật tư bóc tách của đơn
//     thành "vật tư chờ xuất" - phần tồn kho hiển thị phải trừ đi dù kho chưa xuất thật.
//   - Kế hoạch xác nhận Đã xuất khi kho xuất thực tế (được đi thẳng từ Chưa xử lý): đơn nhả phần
//     để dành, vì lúc đó kế toán đã trừ kho thật.
// Trạng thái có đúng 1 nguồn: sheet TRANG_THAI_DON_HANG trong Database bóc tách, chỉ app ghi, có nhật ký.
// App KHÔNG BAO GIỜ ghi vào số liệu kế toán - công tắc tồn kho chỉ đổi cách HIỂN THỊ.
// ============================================================================
// PART: sản phẩm đã xuất một phần số bộ (đơn lớn làm 2-3 đợt) - phần bộ chưa xuất vẫn được giữ vật tư.
const MRP_ST = Object.freeze({ NEW: 'Chưa xử lý', WAIT: 'Chờ xuất', PART: 'Xuất một phần', DONE: 'Đã xuất' });
// Sai số dấu phẩy động (VD 1.323 - 1.323 ra 2e-16) - nhỏ hơn mức này coi như bằng 0, không báo thiếu ảo.
const MRP_EPSILON = 1e-6;

let mrpData = null;              // { orders, demand, warnings, warnCounts, lastRead } từ getMrpData
let mrpLoading = false;
let mrpSaving = false;
let mrpSubTab = 'status';        // 'status' = Trạng thái đơn hàng | 'pick' = Chọn đơn chờ xuất
const mrpPendingWait = new Map(); // mãĐH -> true (muốn Chờ xuất) / false (muốn về Chưa xử lý), CHƯA lưu
const mrpSelectedForIssue = new Set(); // đơn đang tích ở tab Trạng thái để xác nhận Đã xuất hàng loạt
const mrpExpanded = new Set();   // mã vật tư đang mở chi tiết "thuộc những đơn nào"
let lastMrpView = null;          // bảng tổng hợp đang hiển thị - dùng cho Xuất Excel đúng lát cắt
let waitingStockMode = false;    // ô tích: bảng tồn kho hiển thị tồn ĐÃ TRỪ vật tư chờ xuất
let transitStockMode = false;    // ô tích: bảng tồn kho CỘNG thêm vật tư đi đường (hàng đã đặt đang về)
let transitRowsByKey = {};       // mãVT (chuẩn hóa) -> các dòng đang về từ file mua hàng
let waitingById = {};            // mãVT -> tổng SL chờ xuất (chỉ tính trạng thái ĐÃ LƯU)
let waitingOrderCount = 0;

function normalizeMrpText(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Chuẩn hóa MÃ vật tư để so khớp giữa bóc tách và tồn kho: trong dữ liệu đang có 2 loại chữ "Đ" nhìn giống
// hệt nhau nhưng khác mã ký tự - Đ tiếng Việt (U+0110) và Ð tiếng Iceland (U+00D0), VD BLĐ460880 vs BLÐ8812150.
// Không quy về 1 loại thì cùng 1 vật tư sẽ bị báo "Không có trong kho" dù kho vẫn có hàng.
// Ngoài ra chỉ giữ lại CHỮ và SỐ: mã chép từ phần mềm kế toán hay dính ký tự vô hình (dấu cách đặc biệt U+00A0,
// ký tự rỗng U+200B...) hoặc lệch dấu gạch/chấm - mắt không thấy nhưng máy coi là khác mã.
function normalizeMrpCode(value) {
    return String(value || '').normalize('NFC')
        .replace(/\u00D0/g, '\u0110').replace(/\u00F0/g, '\u0111')
        .replace(/[^\p{L}\p{N}]/gu, '')
        .toUpperCase();
}

// Đơn vị cùng nghĩa nhưng ghi khác nhau giữa kho và bóc tách (kho "Cái", bóc tách "Chiếc") - coi là một,
// để không gắn nhãn "ĐVT khác" sai cho hàng loạt bulong, đệm, ecu.
// (so sau khi đã bỏ dấu: "Mét" -> "met", "Lít" -> "lit").
// Đơn vị ĐẾM TỪNG CÁI (cái, chiếc, viên, con) gọi khác nhau nhưng cùng bản chất -> coi là một. Mã khớp kho thì
// hiển thị ĐVT của kế toán làm chuẩn; chỉ còn cảnh báo khi 2 bên đo bằng thứ khác hẳn (VD Kg vs Tấm).
const MRP_UNIT_SYNONYMS = {
    'cai': 'chiec', 'chiec': 'chiec', 'vien': 'chiec', 'con': 'chiec',
    'm': 'm', 'met': 'm',
    'l': 'l', 'lit': 'l',
    'kg': 'kg', 'kilogam': 'kg', 'kilogram': 'kg'
};
function normalizeMrpUnit(value) {
    const u = normalizeMrpText(value).replace(/\.$/, '');
    return MRP_UNIT_SYNONYMS[u] || u;
}

function formatMrpQty(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function mrpStatusBadge(status) {
    const cls = status === MRP_ST.DONE ? 'badge-success' : status === MRP_ST.WAIT ? 'badge-warning' : status === MRP_ST.PART ? 'badge-part' : 'badge-info';
    return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
}

// Tồn kế toán gốc của 1 dòng - luôn dùng số này cho mọi phép tính của module, không dùng item.stock
// (item.stock có thể đang bị công tắc tồn kho đổi thành số đã trừ chờ xuất).
function accountingStockOf(item) {
    return item && Number.isFinite(item.accountingStock) ? item.accountingStock : (item ? item.stock : 0);
}

// ---------------------------------------------------------------------------
// TẢI DỮ LIỆU
// ---------------------------------------------------------------------------
async function loadMrpData() {
    if (!currentUser || !hasPermission('VIEW_MRP') || mrpLoading) return false;
    mrpLoading = true;
    const btn = document.getElementById('btn-mrp-reload');
    if (btn) { btn.disabled = true; btn.innerText = '🔄 Đang tải...'; }
    setMrpStatus('🕒 Đang tải dữ liệu bóc tách...', false, '🕒 Đang tải dữ liệu mua hàng (hàng đi đường)...');
    try {
        const data = await apiPost('getMrpData', { token: currentUser.token });
        if (isUnauthorizedResponse(data)) return false;
        if (!data || !data.success) throw new Error((data && data.error) || 'Không tải được dữ liệu.');
        mrpData = data;
        // Tải lại = lấy trạng thái mới nhất trên máy chủ -> bỏ các thay đổi chưa lưu (đã có thể lỗi thời).
        mrpPendingWait.clear();
        mrpSelectedForIssue.clear();
        rebuildWaitingMap();
        renderMrpPanel();
        renderTransitPanel();
        if (waitingStockMode || transitStockMode) renderTable();
        return true;
    } catch (err) {
        console.error('Lỗi tải dữ liệu vật tư chờ xuất:', err);
        // Giữ nguyên bảng cũ nếu đã có - chỉ báo lỗi ở dòng trạng thái, không xóa trắng màn hình.
        setMrpStatus('❌ ' + (err.message === 'INVALID_SERVER_RESPONSE' ? 'Máy chủ trả dữ liệu không hợp lệ.' : err.message), true);
        return false;
    } finally {
        mrpLoading = false;
        if (btn) { btn.disabled = false; btn.innerText = '🔄 Tải lại dữ liệu bóc tách'; }
    }
}

// Ghi trạng thái tải ở CẢ tab Chờ xuất lẫn tab Đi đường - 2 tab dùng chung 1 lần tải dữ liệu, nếu chỉ báo
// ở 1 tab thì tải lỗi khi đang đứng ở tab kia sẽ im lặng, người dùng không biết vì sao trống.
// transitText: câu riêng cho tab Đi đường (VD lúc đang tải); bỏ trống = dùng chung text;
// null = CHỈ ghi ở tab Chờ xuất (việc riêng của tab đó như lưu trạng thái đơn, giờ cập nhật bóc tách).
function setMrpStatus(text, isError, transitText) {
    [['mrp-status', text], ['transit-status', transitText === null ? null : (transitText || text)]].forEach(([id, msg]) => {
        if (msg === null) return;
        const el = document.getElementById(id);
        if (!el) return;
        el.innerText = msg;
        el.style.color = isError ? 'var(--danger)' : '#64748b';
    });
}

function openMrpPanel() {
    if (!hasPermission('VIEW_MRP')) return;
    showOnlyPanel('mrp-panel');
    if (mrpData) renderMrpPanel();
    else loadMrpData();
}

function openTransitPanel() {
    if (!hasPermission('VIEW_MRP')) return;
    showOnlyPanel('transit-panel');
    if (mrpData) renderTransitPanel();
    else loadMrpData();
}

// ---------------------------------------------------------------------------
// TAB VẬT TƯ ĐI ĐƯỜNG - hàng đã đặt đang về, đọc từ file Quản lý mua hàng (IMPORTRANGE về MH_VTTB/MH_XNK/MH_VHIP)
// ---------------------------------------------------------------------------
let lastTransitView = null;
function renderTransitPanel() {
    const body = document.getElementById('transitBody');
    if (!body) return;
    const status = document.getElementById('transit-status');
    if (!mrpData) { status.innerText = '🕒 Chưa tải dữ liệu.'; return; }
    const tr = mrpData.transit || { rows: [], noCode: [], sheets: [] };

    // Tình trạng từng sheet nguồn - để biết ngay sheet nào chưa import, sheet nào thiếu cột Mã vật tư.
    const anyFound = tr.sheets.some(s => s.found);
    document.getElementById('transit-setup-note').style.display = anyFound ? 'none' : 'block';
    status.innerHTML = tr.sheets.map(s => !s.found
        ? `<span style="color:var(--danger);">⚠ ${escapeHtml(s.name)}: chưa có sheet</span>`
        : `<b>${escapeHtml(s.name.replace(/^MH_/, ''))}</b>: ${s.pending} dòng đang về` +
          (s.noCode ? `, <span style="color:var(--danger);">${s.noCode} dòng chưa có mã</span>` : '') +
          (s.missingCols.length ? ` <span style="color:var(--danger);">(thiếu cột: ${escapeHtml(s.missingCols.join(', '))})</span>` : '')
    ).join(' · ');

    const stockById = {};
    flatInventoryList.forEach(item => {
        if (isPriceSheetName(item.sheet)) return;
        const k = normalizeMrpCode(item.id);
        if (k && !stockById[k]) stockById[k] = item;
    });
    // Mã có trong bóc tách của đơn Chờ xuất - để lọc "chỉ vật tư phục vụ dự án" đúng như Mua hàng quan tâm.
    const btKeys = new Set(computeWaitingNeeds(false).rows.map(r => r.key));

    const term = normalizeMrpText(document.getElementById('transitSearch').value);
    const onlyBt = document.getElementById('transitOnlyBt').checked;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const match = t => !term || [t.code, t.name, t.supplier, t.request, t.ref].some(v => normalizeMrpText(v).includes(term));

    const rows = tr.rows.filter(t => match(t) && (!onlyBt || btKeys.has(normalizeMrpCode(t.code))))
        .sort((a, b) => (a.etaTs || Infinity) - (b.etaTs || Infinity));
    const noCode = tr.noCode.filter(match);
    lastTransitView = { rows, noCode };

    const overdueCount = tr.rows.filter(t => t.etaTs && t.etaTs < today.getTime()).length;
    document.getElementById('transit-stats').innerHTML = `
        <div class="mrp-stat"><span>Dòng đang về có mã</span><b>${tr.rows.length}</b></div>
        <div class="mrp-stat"><span>Phục vụ đơn chờ xuất</span><b>${tr.rows.filter(t => btKeys.has(normalizeMrpCode(t.code))).length}</b></div>
        <div class="mrp-stat mrp-stat-warning"><span>Quá ngày dự kiến</span><b>${overdueCount}</b></div>
        <div class="mrp-stat mrp-stat-warning"><span>Đang về chưa có mã</span><b>${tr.noCode.length}</b></div>`;

    body.innerHTML = !rows.length
        ? `<tr><td colspan="8" style="color:#94a3b8; padding:20px;">${tr.rows.length ? 'Không có dòng nào khớp bộ lọc.' : 'Chưa có dòng đang về nào có mã vật tư.'}</td></tr>`
        : rows.map(t => {
            const item = stockById[normalizeMrpCode(t.code)];
            const overdue = t.etaTs && t.etaTs < today.getTime();
            const flags = [
                !item ? '<span class="badge badge-info" title="Mã này chưa có trong danh sách tồn kho kế toán (tồn 0) - vẫn được cộng khi hàng về">Kho chưa có mã</span>' : '',
                item && !isTransitUnitCompatible(t.unit, item.unit) ? `<span class="badge badge-warning" title="ĐVT đơn mua (${escapeHtml(t.unit)}) khác ĐVT kho (${escapeHtml(item.unit)}) - KHÔNG được cộng vào tồn">⚠ Khác ĐVT kho</span>` : '',
                btKeys.has(normalizeMrpCode(t.code)) ? '<span class="badge badge-success" title="Mã có trong bóc tách của đơn đang Chờ xuất">Phục vụ đơn chờ</span>' : ''
            ].join(' ');
            return `<tr>
                <td class="text-left font-bold">${escapeHtml(t.code)}</td>
                <td class="text-left">${escapeHtml(t.name)} ${flags}</td>
                <td>${escapeHtml(t.unit)}</td>
                <td class="text-right font-bold" style="color:var(--vh-blue-dark);">${formatMrpQty(t.qty)}</td>
                <td class="text-right" style="font-size:12px; color:#64748b;">${formatMrpQty(t.arrived)} / ${formatMrpQty(t.ordered)}</td>
                <td class="text-left">${escapeHtml(t.supplier || '—')}</td>
                <td>${escapeHtml(t.eta || '—')}${overdue ? ' <span class="badge badge-danger">Quá hạn</span>' : ''}</td>
                <td class="text-left" style="font-size:12px;">${escapeHtml(t.sheet)} · dòng ${t.row}${t.request ? '<br>YCMH ' + escapeHtml(t.request) : ''}${t.ref ? '<br>' + escapeHtml(t.ref) : ''}</td>
            </tr>`;
        }).join('');

    document.getElementById('transit-nocode-count').innerText = tr.noCode.length;
    document.getElementById('transitNoCodeBody').innerHTML = !noCode.length
        ? `<tr><td colspan="6" style="color:#94a3b8; padding:14px;">${tr.noCode.length ? 'Không có dòng nào khớp bộ lọc.' : '✅ Mọi dòng đang về đều đã có mã vật tư.'}</td></tr>`
        : noCode.map(t => `<tr>
            <td>${escapeHtml(t.sheet)} · ${t.row}</td>
            <td class="text-left">${escapeHtml(t.name)}</td>
            <td>${escapeHtml(t.unit)}</td>
            <td class="text-right">${formatMrpQty(t.qty)}</td>
            <td class="text-left">${escapeHtml(t.supplier || '—')}</td>
            <td class="text-left" style="font-size:12px;">${t.request ? 'YCMH ' + escapeHtml(t.request) : ''}${t.ref ? ' · ' + escapeHtml(t.ref) : ''}</td>
        </tr>`).join('');
}

function exportTransit() {
    if (!hasPermission('VIEW_MRP')) return;
    if (typeof XLSX === 'undefined') { showAlert('Không tải được thư viện xuất Excel (có thể do mất mạng).', 'error'); return; }
    if (!lastTransitView || (!lastTransitView.rows.length && !lastTransitView.noCode.length)) { showAlert('Không có dữ liệu để xuất.', 'error'); return; }
    const round = n => Math.round(Number(n) * 1000) / 1000;
    const toRow = t => ({ 'Sheet': t.sheet, 'Dòng': t.row, 'Mã Vật Tư': t.code || '', 'Tên Vật Tư': t.name, 'ĐVT': t.unit,
        'Còn Về': round(t.qty), 'Đã Đặt': round(t.ordered), 'Đã Về': round(t.arrived), 'NCC': t.supplier, 'Dự Kiến Về': t.eta, 'Số YCMH': t.request, 'Phục Vụ': t.ref });
    const wb = XLSX.utils.book_new();
    if (lastTransitView.rows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lastTransitView.rows.map(toRow)), 'Dang ve');
    // Sheet riêng "chưa có mã" - gửi thẳng cho Mua hàng bổ sung mã (có sẵn số sheet + số dòng để tìm).
    if (lastTransitView.noCode.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lastTransitView.noCode.map(toRow)), 'Chua co ma');
    const now = new Date(); const pad = n => String(n).padStart(2, '0');
    XLSX.writeFile(wb, `VatTuDiDuong_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.xlsx`);
}

function switchMrpSubTab(tab) {
    mrpSubTab = tab === 'pick' ? 'pick' : 'status';
    renderMrpPanel();
}

// ---------------------------------------------------------------------------
// TÍNH TOÁN
// ---------------------------------------------------------------------------
// Trạng thái "đang có hiệu lực" để xem trước: trạng thái đã lưu + thay đổi tích chờ chưa lưu.
// ---------------------------------------------------------------------------
// GỢI Ý TẤM LẺ (chỉ tham khảo - KHÔNG cộng vào số liệu cân đối)
// Kế toán ghi mỗi tấm lẻ một mã riêng, kích thước nằm ngay trong tên: "Thép tấm Q355 20x2000x3400",
// "Thép tấm Q355 tròn D700x115". App đọc tên để tìm tấm lẻ CÙNG CHIỀU DÀY (mác nào cũng được - các mác
// thay thế được cho nhau ở tấm lẻ) và gợi ý cho người mua cân nhắc mua bớt tấm nguyên.
// ---------------------------------------------------------------------------
// Khổ tấm nguyên. Quy tắc theo TỪNG CHIỀU DÀY: khổ LỚN NHẤT đang có là tiêu chuẩn, khổ nhỏ hơn là tấm lẻ.
// Ngoại lệ: 1500x3000 và 3000x12000 LUÔN là tấm nguyên ở mọi chiều dày, không làm khổ khác thành tấm lẻ;
//           có 2000x12000 thì 2000x6000 cùng chiều dày vẫn là tiêu chuẩn.
const PLATE_SIZE_RANK = ['1500x6000', '2000x6000', '2000x12000'];   // nhỏ -> lớn
const PLATE_SPECIAL_SIZES = ['1500x3000', '3000x12000'];
const STEEL_KG_PER_MM3 = 7.85e-6;

function parsePlateName(name) {
    const t = String(name || '').normalize('NFC').replace(/×/g, 'x');
    const m = t.match(/th[ée]p\s+t[ấa]m\s+([A-Za-z0-9]+)\s+(tr[òo]n\s+)?D?\s*(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)(?:\s*x\s*(\d+(?:[.,]\d+)?))?/i);
    if (!m) return null;
    const n = v => v == null ? null : Number(String(v).replace(',', '.'));
    const grade = m[1].toUpperCase();
    if (m[2]) {   // tròn: "D700 x 115" = đường kính x chiều dày
        const d = n(m[3]), th = n(m[4]);
        return { grade, thick: th, round: true, dia: d, kg: Math.PI * (d / 2) ** 2 * th * STEEL_KG_PER_MM3, sizeText: `tròn D${d}` };
    }
    if (m[5] == null) return null;
    const th = n(m[3]), w = n(m[4]), l = n(m[5]);
    // Khóa khổ: cạnh ngắn x cạnh dài (tên có thể ghi 6000x2000 hay 2000x6000)
    const sizeKey = `${Math.min(w, l)}x${Math.max(w, l)}`;
    return { grade, thick: th, round: false, w, l, sizeKey, kg: th * w * l * STEEL_KG_PER_MM3, sizeText: `${w}×${l}` };
}

// Tập khổ tiêu chuẩn theo từng chiều dày, suy ra từ các tên thép tấm (danh sách tồn kho + bóc tách).
function buildPlateStandards(names) {
    const present = {};   // dày -> khổ trong PLATE_SIZE_RANK đang xuất hiện
    names.forEach(nm => {
        const pl = parsePlateName(nm);
        if (!pl || pl.round || !(pl.thick > 0) || !PLATE_SIZE_RANK.includes(pl.sizeKey)) return;
        (present[pl.thick] = present[pl.thick] || new Set()).add(pl.sizeKey);
    });
    const std = {};
    Object.keys(present).forEach(t => {
        const largest = PLATE_SIZE_RANK.filter(k => present[t].has(k)).pop();
        const set = new Set([largest, ...PLATE_SPECIAL_SIZES]);
        if (largest === '2000x12000') set.add('2000x6000');
        std[t] = set;
    });
    return std;
}

function isStandardPlate(pl, standards) {
    if (!pl || pl.round) return false;
    if (PLATE_SPECIAL_SIZES.includes(pl.sizeKey)) return true;
    const set = standards[pl.thick];
    return !!(set && set.has(pl.sizeKey));
}

// Chỉ mục thép tấm đang có trong kho theo chiều dày: cả tấm lẻ lẫn tấm nguyên (isFull), để gợi ý
// tấm lẻ và "tấm nguyên khác mã" (khác mác hoặc cùng mác khác khổ) - dựng lại mỗi lần tính, rất nhẹ.
function buildRemnantIndex(standards) {
    const idx = {};
    flatInventoryList.forEach(item => {
        if (isPriceSheetName(item.sheet)) return;
        const qty = accountingStockOf(item);
        if (!(qty > 0)) return;
        const pl = parsePlateName(item.name);
        if (!pl || !(pl.thick > 0)) return;
        (idx[pl.thick] = idx[pl.thick] || []).push({ code: String(item.id).trim(), name: item.name, qty, isFull: isStandardPlate(pl, standards), ...pl });
    });
    return idx;
}

// Họ mác để xếp thứ tự gợi ý: Q355B, Q355C... cùng họ Q355.
function gradeFamily(g) { return String(g || '').replace(/^(.*\d)[A-Z]$/, '$1'); }

// Gợi ý cho 1 dòng thép tấm nguyên, cùng chiều dày:
//   - list     : TẤM LẺ (khổ không tiêu chuẩn), mác nào cũng được;
//   - fullList : TẤM NGUYÊN KHÁC MÃ (khác mác như cần A572 gợi ý Q355, hoặc cùng mác khác khổ như 2000x12000).
// Chỉ là ĐỀ XUẤT - người mua quyết định. Tích tấm nào thì tấm đó được giữ cho mã này và trừ vào "mua sau tận dụng".
function remnantHintFor(rowName, rowCode, remIdx, standards) {
    const pl = parsePlateName(rowName);
    if (!isStandardPlate(pl, standards)) return null;
    const target = normalizeMrpCode(rowCode);
    const resBy = {};
    ((mrpData && mrpData.reservations) || []).forEach(x => { (resBy[normalizeMrpCode(x.remnant)] = resBy[normalizeMrpCode(x.remnant)] || []).push(x); });
    const fam = gradeFamily(pl.grade);
    const all = (remIdx[pl.thick] || []).filter(r => normalizeMrpCode(r.code) !== target).map(r => {
        const rs = resBy[normalizeMrpCode(r.code)] || [];
        const mineRec = rs.find(x => normalizeMrpCode(x.target) === target);
        const others = rs.filter(x => x !== mineRec);
        const othersQty = others.reduce((s, x) => s + (Number(x.qty) || 0), 0);
        const available = Math.max(0, r.qty - othersQty);          // phần còn giữ được cho mã này
        const mineRaw = mineRec ? Number(mineRec.qty) || 0 : 0;
        const mine = Math.min(mineRaw, available);                  // kho giảm bớt -> tự hạ phần giữ xuống bằng tồn thực
        return Object.assign({}, r, { others, othersQty, available, mine, mineRaw, mineRec, over: mineRaw > available, sameFamily: gradeFamily(r.grade) === fam });
    })   // tấm đã bị giữ hết cho mã khác VẪN hiện (để thấy ai giữ, giữ cho mã nào) - số tổng chỉ tính phần còn trống
      .sort((a, b) => ((b.available > 0 || b.mineRaw > 0) - (a.available > 0 || a.mineRaw > 0)) || (b.sameFamily - a.sameFamily) || (b.kg - a.kg));
    const list = all.filter(r => !r.isFull);
    const fullList = all.filter(r => r.isFull);
    // Không còn tấm nào trống và mã này cũng không giữ tấm nào -> không có gì để gợi ý (bảng chi tiết vẫn không cần hiện).
    if (!all.some(r => r.available > 0 || r.mineRaw > 0)) return null;
    const kgOf = arr => arr.reduce((s, r) => s + r.kg * r.available, 0);
    const mineKg = all.reduce((s, r) => s + r.kg * r.mine, 0);
    return { list, fullList,
             pieces: list.reduce((s, r) => s + r.available, 0), totalKg: kgOf(list), equivSheets: kgOf(list) / pl.kg,
             fullPieces: fullList.reduce((s, r) => s + r.available, 0), fullEquiv: kgOf(fullList) / pl.kg,
             mineCount: all.reduce((s, r) => s + r.mine, 0), mineEq: mineKg / pl.kg,
             fullSize: pl.sizeText, grade: pl.grade, thick: pl.thick, target: String(rowCode || '').trim() };
}

// Tấm của CHÍNH mã này đang được giữ để tận dụng cho mã khác (VD tấm Q355 được giữ thay cho A572):
// hiện cảnh báo trên dòng để người xem không tính số tấm đó hai lần.
function reservedOutFor(rowCode) {
    const k = normalizeMrpCode(rowCode);
    return ((mrpData && mrpData.reservations) || []).filter(x => normalizeMrpCode(x.remnant) === k && normalizeMrpCode(x.target) !== k);
}

// Số tấm nguyên đề xuất mua trước / sau khi trừ phần tấm lẻ ĐÃ TÍCH tận dụng (người dùng chủ động chọn).
function purchasePlan(r) {
    const base = roundUpPurchase(r.shortage, r.unit);
    if (!r.remnant || !(r.remnant.mineEq > 0)) return { base, after: base };
    return { base, after: roundUpPurchase(Math.max(0, r.shortage - r.remnant.mineEq), r.unit) };
}

// Gộp nhu cầu của các ĐƠN VỊ đang giữ vật tư (Chờ xuất + phần chưa xuất của Xuất một phần) theo mã.
// includePending = true: tính cả thay đổi tích chờ chưa lưu (để xem trước ở tab Chọn đơn).
function computeWaitingNeeds(includePending) {
    const { units } = mrpIndex();
    const active = units.map(u => ({ u, f: unitReserveFactor(u, includePending) })).filter(x => x.f > MRP_EPSILON);
    const activeByKey = {};
    active.forEach(x => { activeByKey[x.u.key] = x; });

    const stockById = {};
    const stockByName = {};   // chỉ dùng để GỢI Ý khi lệch mã, không dùng để lấy số tồn
    flatInventoryList.forEach(item => {
        if (isPriceSheetName(item.sheet)) return; // Giá TB không phải tồn kho thật
        const id = normalizeMrpCode(item.id);
        if (id && !stockById[id]) stockById[id] = item;
        const nm = normalizeMrpText(item.name).replace(/[^a-z0-9]/g, '');
        if (nm && !stockByName[nm]) stockByName[nm] = item;
    });

    const coded = {};
    const noCode = {};
    const addLine = (x, code, name, unit, qty) => {
        // Xuất một phần: chỉ giữ phần của số bộ CHƯA xuất (VD còn 100/150 bộ -> giữ 2/3). Trải phôi tính cho cả
        // sản phẩm nên chia tỷ lệ là gần đúng - chấp nhận được cho giữ chỗ; xuất đủ thì phần giữ về 0.
        const q = (Number(qty) || 0) * x.f;
        if (!(q > 0)) return;
        const u = x.u, o = u.order;
        const ref = { orderKey: u.key, qty: q, unit, product: u.isProduct ? u.name : o.product, project: o.project, date: o.date,
                      partial: x.f < 1 - MRP_EPSILON, remainSets: u.isProduct ? Math.round(u.sets * x.f) : null, sets: u.sets };
        if (code) {
            const ck = normalizeMrpCode(code);
            const g = coded[ck] || (coded[ck] = { code, key: ck, demandName: name, demandUnit: unit, need: 0, orders: [] });
            g.need += q;
            g.orders.push(ref);
        } else {
            // Vật tư chưa có mã: gom theo tên đã bỏ dấu/khoảng trắng thừa ("Ống inox" = "Ống Inox").
            const k = normalizeMrpText(name);
            const g = noCode[k] || (noCode[k] = { name, unit, need: 0, orders: [] });
            g.need += q;
            g.orders.push(ref);
        }
    };
    // Đơn có sheet con: lấy nhu cầu theo SẢN PHẨM (chính xác hơn sheet tổng hợp); đơn cũ: theo đơn.
    ((mrpData && mrpData.productDemand) || []).forEach(([pkey, , code, name, unit, qty]) => {
        const x = activeByKey[pkey];
        if (x && x.u.isProduct) addLine(x, code, name, unit, qty);
    });
    ((mrpData && mrpData.demand) || []).forEach(([okey, code, name, unit, qty]) => {
        const x = activeByKey[okey];
        if (x && !x.u.isProduct) addLine(x, code, name, unit, qty);
    });

    const sortOrders = list => list.sort((a, b) => String(b.orderKey).localeCompare(String(a.orderKey), 'vi', { numeric: true }));
    const transitIdx = groupTransitByCode();
    // Khổ tiêu chuẩn suy từ MỌI tên thép tấm đang biết (cả mã tồn 0 và vật tư trong bóc tách).
    const plateStandards = buildPlateStandards(
        flatInventoryList.filter(i => !isPriceSheetName(i.sheet)).map(i => i.name)
            .concat(Object.values(coded).map(g => g.demandName)));
    const remIdx = buildRemnantIndex(plateStandards);
    const rows = Object.values(coded).map(g => {
        const item = stockById[g.key];
        const stock = accountingStockOf(item);
        // Hàng đi đường: chỉ cộng dòng đo CÙNG KIỂU với kho (hoặc với bóc tách nếu kho chưa có mã) -
        // mua theo kg mà kho tính theo Tấm thì cộng vào là sai, nên tách riêng để báo.
        const baseUnit = item && item.unit ? item.unit : g.demandUnit;
        const transitAll = transitIdx[g.key] || [];
        const transitRows = transitAll.filter(t => isTransitUnitCompatible(t.unit, baseUnit));
        const transitSkipped = transitAll.filter(t => !transitRows.includes(t));
        const transit = transitRows.reduce((s, t) => s + t.qty, 0);
        // Còn lại = Tồn kế toán − Chờ xuất + Đi đường (đi đường tính dương, bóc tách tính âm).
        const remain = stock - g.need + transit;
        // Tồn âm (lỗi số liệu) coi như 0 khi tính thiếu - không để nó "cộng thêm" vào số cần mua.
        let shortage = g.need - Math.max(stock, 0) - transit;
        if (shortage < MRP_EPSILON) shortage = 0;
        // Không khớp mã nhưng kho có vật tư CÙNG TÊN -> gần như chắc chắn là lệch mã giữa VT BT và kế toán.
        // Chỉ gợi ý để người dùng sửa VT BT; KHÔNG tự lấy tồn theo tên vì tên trùng vẫn có thể khác vật tư.
        const nameHint = !item ? stockByName[normalizeMrpText(g.demandName).replace(/[^a-z0-9]/g, '')] : null;
        // Mã nằm ở nhiều đơn: so ĐVT của TỪNG đơn (không chỉ đơn đầu tiên) - đơn nào lệch thì chỉ ra đúng đơn đó.
        const unitGroups = {};   // ĐVT (đã chuẩn hóa) -> { label, orders: [] }
        g.orders.forEach(o => {
            const k = normalizeMrpUnit(o.unit);
            (unitGroups[k] = unitGroups[k] || { label: o.unit || '(trống)', orders: [] }).orders.push(o.orderKey);
        });
        const stockUnitKey = item && item.unit ? normalizeMrpUnit(item.unit) : null;
        const unitKeys = Object.keys(unitGroups);
        const unitMismatch = stockUnitKey ? unitKeys.some(k => k !== stockUnitKey) : unitKeys.length > 1;
        const unitDetail = unitKeys.map(k => `${unitGroups[k].label}: ${unitGroups[k].orders.join(', ')}`).join(' · ');
        return {
            nameHintCode: nameHint ? String(nameHint.id).trim() : '',
            // Hiển thị đúng mã như bên kho (nếu khớp được) để người xem tra cứu tiếp không bị lệch ký tự.
            code: item ? String(item.id).trim() : g.code, key: g.key, name: item ? item.name : g.demandName, unit: item ? item.unit : g.demandUnit,
            demandUnit: g.demandUnit, need: g.need, stock, remain, shortage, inStockList: !!item,
            transit, transitRows, transitSkipped,
            // Chỉ để GỢI Ý - không đưa vào stock/remain/shortage.
            remnant: remnantHintFor(item ? item.name : g.demandName, item ? item.id : g.code, remIdx, plateStandards),
            reservedOut: reservedOutFor(item ? item.id : g.code),
            // ĐVT bóc tách khác ĐVT kho (VD Bộ vs Kg) thì phép trừ vô nghĩa - đánh dấu để người xem kiểm tra.
            unitMismatch, unitDetail,
            orders: sortOrders(g.orders)
        };
    }).sort((a, b) => {
        // Mã thiếu lên trước, thiếu gần như toàn bộ lên trên. Không so số tuyệt đối vì khác đơn vị.
        if ((a.shortage > 0) !== (b.shortage > 0)) return a.shortage > 0 ? -1 : 1;
        if (a.shortage > 0) {
            const diff = (b.shortage / b.need) - (a.shortage / a.need);
            if (Math.abs(diff) > MRP_EPSILON) return diff;
        }
        return String(a.name).localeCompare(String(b.name), 'vi');
    });
    const noCodeRows = Object.values(noCode).map(g => Object.assign(g, { orders: sortOrders(g.orders) }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'vi'));

    const orderCount = new Set(active.map(x => x.u.orderKey)).size;
    return { rows, noCodeRows, orderCount, unitCount: active.length,
             orderKeys: active.map(x => x.u.key).sort((a, b) => a.localeCompare(b, 'vi', { numeric: true })) };
}

// Hàng đi đường gom theo mã (đã chuẩn hóa như mọi chỗ so mã khác: 2 loại chữ Đ, ký tự vô hình...).
function groupTransitByCode() {
    const idx = {};
    ((mrpData && mrpData.transit && mrpData.transit.rows) || []).forEach(t => {
        const k = normalizeMrpCode(t.code);
        if (k) (idx[k] = idx[k] || []).push(t);
    });
    return idx;
}

// Đơn mua ghi ĐVT trống thì tin theo mã; còn lại phải cùng cách đo (cái = chiếc = viên, m = mét...).
function isTransitUnitCompatible(transitUnit, baseUnit) {
    if (!transitUnit || !baseUnit) return true;
    return normalizeMrpUnit(transitUnit) === normalizeMrpUnit(baseUnit);
}

// Dựng lại bảng "mã -> SL chờ xuất" từ trạng thái ĐÃ LƯU, rồi áp lại công tắc tồn kho nếu đang bật.
// Chỉ dùng trạng thái đã lưu: bảng tồn kho là số liệu chung, không được nhảy theo thao tác chưa lưu.
function rebuildWaitingMap() {
    waitingById = {};
    waitingOrderCount = 0;
    if (mrpData) {
        const res = computeWaitingNeeds(false);
        res.rows.forEach(r => { waitingById[r.key] = r.need; });
        waitingOrderCount = res.orderCount;
    }
    transitRowsByKey = groupTransitByCode();
    applyWaitingStockMode();
}

// Công tắc tồn kho: đổi item.stock để TOÀN BỘ phần hiển thị có sẵn (màu Min/Max, 4 ô thống kê, dashboard,
// biểu đồ, Cần đặt hàng, Xuất Excel) tự dùng số đã trừ mà không phải sửa từng chỗ. Số kế toán gốc luôn giữ
// ở item.accountingStock nên tắt công tắc là khôi phục nguyên trạng.
function applyWaitingStockMode() {
    flatInventoryList.forEach(item => {
        if (!Number.isFinite(item.accountingStock)) item.accountingStock = item.stock;
        const isStock = !isPriceSheetName(item.sheet);
        const key = normalizeMrpCode(item.id);
        const waiting = (isStock && waitingStockMode) ? (waitingById[key] || 0) : 0;
        // Đi đường chỉ cộng dòng cùng cách đo với kho (VD kho tính Tấm thì không cộng dòng mua theo kg).
        const transit = (isStock && transitStockMode)
            ? (transitRowsByKey[key] || []).filter(t => isTransitUnitCompatible(t.unit, item.unit)).reduce((s, t) => s + t.qty, 0)
            : 0;
        item.waiting = waiting;
        item.transit = transit;
        item.stock = item.accountingStock - waiting + transit;
    });
    updateWaitingStockUi();
}

// Tiêu đề cột tồn trên bảng tồn kho, theo 2 ô tích đang bật.
function stockColumnLabel() {
    if (waitingStockMode && transitStockMode) return 'Tồn Khả Dụng';
    if (waitingStockMode) return 'Tồn Trừ Chờ Xuất';
    if (transitStockMode) return 'Tồn + Đi Đường';
    return 'Tồn Kho';
}

function updateWaitingStockUi() {
    // Ô tích luôn phản ánh đúng chế độ đang áp dụng (kể cả khi bật thất bại thì tự bỏ tích lại).
    [['chkWaitingStock', 'btn-toggle-waiting-stock', waitingStockMode], ['chkTransitStock', 'btn-toggle-transit-stock', transitStockMode]].forEach(([boxId, wrapId, on]) => {
        const box = document.getElementById(boxId);
        if (box) box.checked = on;
        const wrap = document.getElementById(wrapId);
        if (wrap) wrap.classList.toggle('active', on);
    });
    const banner = document.getElementById('waiting-stock-banner');
    if (banner) {
        const any = waitingStockMode || transitStockMode;
        banner.style.display = any ? 'block' : 'none';
        const parts = [];
        if (waitingStockMode) parts.push(`ĐÃ TRỪ vật tư chờ xuất của ${waitingOrderCount} đơn hàng`);
        if (transitStockMode) parts.push('ĐÃ CỘNG vật tư đi đường (hàng đã đặt đang về)');
        banner.innerText = `🧮 Đang xem tồn kho ${parts.join(' và ')}. Màu cảnh báo Min/Max, thống kê, Cần đặt hàng và Xuất Excel đều theo số này. Bỏ tích để về số liệu kế toán.`;
    }
}

// kind = 'waiting' (Trừ chờ xuất) | 'transit' (Cộng đi đường). 2 ô tích độc lập, bật được cùng lúc.
async function toggleStockAdjust(kind) {
    if (!hasPermission('VIEW_MRP')) return;
    const isWaiting = kind === 'waiting';
    const turningOn = isWaiting ? !waitingStockMode : !transitStockMode;
    if (turningOn && !mrpData) {
        // Lần đầu bật mà chưa có dữ liệu -> tải trước, lỗi thì không bật (tránh hiển thị số sai).
        const box = document.getElementById(isWaiting ? 'chkWaitingStock' : 'chkTransitStock');
        const wrap = document.getElementById(isWaiting ? 'btn-toggle-waiting-stock' : 'btn-toggle-transit-stock');
        const text = document.getElementById(isWaiting ? 'waiting-toggle-text' : 'transit-toggle-text');
        const normal = text ? text.innerText : '';
        if (box) box.disabled = true;
        if (wrap) wrap.classList.add('is-loading');
        if (text) text.innerText = 'Đang tải dữ liệu...';
        const ok = await loadMrpData();
        if (box) box.disabled = false;
        if (wrap) wrap.classList.remove('is-loading');
        if (text) text.innerText = normal;
        if (!ok) {
            updateWaitingStockUi();
            showAlert('Không tải được dữ liệu nên chưa bật được chế độ này. Anh/chị thử lại sau.', 'error');
            return;
        }
    }
    if (isWaiting) waitingStockMode = !waitingStockMode;
    else transitStockMode = !transitStockMode;
    applyWaitingStockMode();
    renderTable();
}
function toggleWaitingStockMode() { return toggleStockAdjust('waiting'); }

// ---------------------------------------------------------------------------
// GHI TRẠNG THÁI
// ---------------------------------------------------------------------------
async function submitOrderStatusChanges(changes, successText) {
    if (!changes.length || mrpSaving) return false;
    mrpSaving = true;
    // Vẽ lại ngay để nút Lưu / Xác nhận hiện vòng quay + khóa mọi ô tích, nút thao tác trong lúc chờ máy chủ.
    renderMrpPanel();
    setMrpStatus('💾 Đang lưu...', false, null);
    try {
        const data = await apiPost('updateOrderStatus', { token: currentUser.token, changes });
        if (isUnauthorizedResponse(data)) return false;
        if (!data || !data.success) {
            showAlert((data && data.error) || 'Lưu thất bại.', 'error');
            setMrpStatus('❌ Chưa lưu được thay đổi.', true, null);
            return false;
        }
        const updated = data.statuses || {};
        ((mrpData.products || []).concat(mrpData.orders)).forEach(o => {
            const u = updated[o.key];
            if (u) { o.status = u.status; o.issued = u.issued || 0; o.statusBy = u.by; o.statusAt = u.at; }
        });
        changes.forEach(c => { mrpPendingWait.delete(c.key); mrpSelectedForIssue.delete(c.key); });
        rebuildWaitingMap();
        if (waitingStockMode) renderTable();
        renderMrpPanel();
        showAlert(successText, 'success');
        return true;
    } catch (err) {
        console.error('Lỗi lưu trạng thái đơn:', err);
        showAlert('Không kết nối được máy chủ, thay đổi chưa được lưu.', 'error');
        setMrpStatus('❌ Không kết nối được máy chủ.', true, null);
        return false;
    } finally {
        mrpSaving = false;
        renderMrpPanel();
    }
}

// Nút đang chờ máy chủ: vòng quay + chữ "Đang lưu..." + mờ, không bấm được lần 2.
function setMrpButtonBusy(btn, busy, normalText) {
    if (!btn) return;
    btn.classList.toggle('btn-busy', busy);
    btn.disabled = busy || btn.disabled;
    if (busy) btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span>Đang lưu...';
    else btn.innerText = normalText;
}

// ---------------------------------------------------------------------------
// ĐƠN VỊ THEO DÕI: SẢN PHẨM (sheet con 26-169.1) nếu đơn có sheet con, còn lại chính ĐƠN (26-169).
// Đơn lớn làm 2-3 đợt: mỗi sản phẩm ghi số bộ đã xuất; phần bộ CHƯA xuất vẫn được giữ vật tư theo tỷ lệ.
// ---------------------------------------------------------------------------
const mrpExpandedOrders = new Set();   // đơn đang mở danh sách sản phẩm (dùng chung 2 tab nhánh)

function mrpIndex() {
    const productsByOrder = {};
    ((mrpData && mrpData.products) || []).forEach(p => (productsByOrder[p.orderKey] = productsByOrder[p.orderKey] || []).push(p));
    Object.values(productsByOrder).forEach(list => list.sort((a, b) => String(a.key).localeCompare(String(b.key), 'vi', { numeric: true })));
    const units = [];
    const byKey = {};
    ((mrpData && mrpData.orders) || []).forEach(o => {
        const ps = productsByOrder[o.key];
        const list = ps && ps.length
            ? ps.map(p => ({ key: p.key, orderKey: o.key, isProduct: true, name: p.name, sets: p.sets, ref: p, order: o }))
            : [{ key: o.key, orderKey: o.key, isProduct: false, name: o.product, sets: 0, ref: o, order: o }];
        list.forEach(u => { units.push(u); byKey[u.key] = u; });
        o._units = list;
    });
    return { units, byKey };
}

function unitStatus(u) { return u.ref.status || MRP_ST.NEW; }
function unitIssued(u) { return unitStatus(u) === MRP_ST.DONE ? u.sets : (Number(u.ref.issued) || 0); }

// Trạng thái xem trước ở tab Chọn đơn: đã lưu + thay đổi tích chờ chưa lưu.
function effectiveUnitStatus(u) {
    if (mrpPendingWait.has(u.key)) return mrpPendingWait.get(u.key) ? MRP_ST.WAIT : MRP_ST.NEW;
    return unitStatus(u);
}
// Chỉ đơn vị Chưa xử lý / Chờ xuất mới tích chọn được; Xuất một phần / Đã xuất là việc của Kế hoạch.
function isUnitPickable(u) { const s = unitStatus(u); return s === MRP_ST.NEW || s === MRP_ST.WAIT; }

// Tỷ lệ vật tư còn phải giữ: Chờ xuất = toàn bộ; Xuất một phần = phần bộ chưa xuất; còn lại = 0.
function unitReserveFactor(u, includePending) {
    const st = includePending ? effectiveUnitStatus(u) : unitStatus(u);
    if (st === MRP_ST.WAIT) return 1;
    if (st === MRP_ST.PART && u.sets > 0) return Math.max(0, (u.sets - unitIssued(u)) / u.sets);
    return 0;
}

// Trạng thái gộp của 1 đơn từ các sản phẩm.
function orderAggregate(o) {
    const units = o._units || [];
    const sts = units.map(unitStatus);
    const same = sts.every(s => s === sts[0]);
    const done = sts.filter(s => s === MRP_ST.DONE).length;
    if (same) return { status: sts[0], label: sts[0], done, total: units.length, mixed: false };
    return { status: 'MIXED', label: `Một phần · ${done}/${units.length} SP đã xuất`, done, total: units.length, mixed: true };
}

function unitLatestUpdate(units) {
    let best = null;
    units.forEach(u => {
        const at = u.ref.statusAt;
        if (!at) return;
        // "HH:mm dd/MM/yyyy" -> số để so sánh
        const m = String(at).match(/(\d+):(\d+) (\d+)\/(\d+)\/(\d+)/);
        const v = m ? Number(m[5] + m[4].padStart(2, '0') + m[3].padStart(2, '0') + m[1].padStart(2, '0') + m[2].padStart(2, '0')) : 0;
        if (!best || v > best.v) best = { v, by: u.ref.statusBy, at };
    });
    return best;
}

function unitStatusBadge(u) {
    const st = unitStatus(u);
    if (st === MRP_ST.PART) return `<span class="badge badge-part">Xuất một phần · ${unitIssued(u)}/${u.sets} bộ</span>`;
    return mrpStatusBadge(st);
}
function orderBadge(o) {
    const a = orderAggregate(o);
    if (a.mixed) return `<span class="badge badge-part">${escapeHtml(a.label)}</span>`;
    if (a.status === MRP_ST.PART && (o._units || []).length === 1) return unitStatusBadge(o._units[0]);
    return mrpStatusBadge(a.status);
}

// ---------------------------------------------------------------------------
// GHI TRẠNG THÁI (mọi thao tác gom thành danh sách thay đổi theo ĐƠN VỊ, gửi 1 lần)
// ---------------------------------------------------------------------------
function changeFor(u, to, issued) {
    return { key: u.key, from: unitStatus(u), fromIssued: unitIssued(u), to, issued: issued || 0 };
}

function saveWaitingList() {
    if (!hasPermission('EDIT_WAITING_LIST') || !mrpData || mrpSaving) return;
    const { byKey } = mrpIndex();
    const changes = [];
    mrpPendingWait.forEach((want, key) => {
        const u = byKey[key];
        if (!u || !isUnitPickable(u)) return;
        const to = want ? MRP_ST.WAIT : MRP_ST.NEW;
        if (to !== unitStatus(u)) changes.push(changeFor(u, to));
    });
    if (!changes.length) { mrpPendingWait.clear(); renderMrpPanel(); return; }
    const add = changes.filter(c => c.to === MRP_ST.WAIT).length;
    const parts = [];
    if (add) parts.push(`đưa ${add} sản phẩm/đơn vào Chờ xuất`);
    if (changes.length - add) parts.push(`bỏ ${changes.length - add} sản phẩm/đơn khỏi Chờ xuất`);
    showConfirm(`Anh/chị xác nhận ${parts.join(' và ')}?`, () => {
        submitOrderStatusChanges(changes, `✅ Đã lưu danh mục chờ xuất (${changes.length} thay đổi).`);
    });
}

function cancelWaitingChanges() {
    mrpPendingWait.clear();
    renderMrpPanel();
}

// Xác nhận xuất ĐỦ cho cả đơn (mọi sản phẩm chưa xuất đủ).
function confirmIssued(orderKeys) {
    if (!hasPermission('CONFIRM_ISSUED') || !mrpData || mrpSaving) return;
    mrpIndex();
    const orders = mrpData.orders.filter(o => orderKeys.includes(o.key));
    const changes = [];
    orders.forEach(o => (o._units || []).forEach(u => { if (unitStatus(u) !== MRP_ST.DONE) changes.push(changeFor(u, MRP_ST.DONE, u.sets)); }));
    if (!changes.length) return;
    const label = orders.length === 1 ? `đơn ${orders[0].key}` : `${orders.length} đơn: ${orders.map(o => o.key).join(', ')}`;
    showConfirm(`Xác nhận kho ĐÃ XUẤT ĐỦ vật tư cho ${label}?\n\n${changes.length} sản phẩm sẽ chuyển sang Đã xuất, phần vật tư giữ chỗ được nhả ra.`, () => {
        submitOrderStatusChanges(changes, `✅ Đã xác nhận xuất kho (${changes.length} sản phẩm).`);
    });
}

// Hoàn tác cả đơn (nhập nhầm): mọi sản phẩm đã xuất / xuất một phần về Chưa xử lý.
function undoIssued(orderKey) {
    if (!hasPermission('CONFIRM_ISSUED') || !mrpData || mrpSaving) return;
    mrpIndex();
    const o = mrpData.orders.find(x => x.key === orderKey);
    if (!o) return;
    const changes = (o._units || []).filter(u => [MRP_ST.DONE, MRP_ST.PART].includes(unitStatus(u))).map(u => changeFor(u, MRP_ST.NEW));
    if (!changes.length) return;
    showConfirm(`Hoàn tác: đưa đơn ${orderKey} (${changes.length} sản phẩm) về "Chưa xử lý"?\n\nChỉ dùng khi nhập nhầm. Thao tác này được ghi vào nhật ký.`, () => {
        submitOrderStatusChanges(changes, `↩ Đã đưa đơn ${orderKey} về Chưa xử lý.`);
    });
}

// Ghi số bộ đã xuất cho 1 sản phẩm: 0 = hoàn tác, đủ = Đã xuất, giữa chừng = Xuất một phần.
function saveUnitIssued(key, rawValue) {
    if (!hasPermission('CONFIRM_ISSUED') || !mrpData || mrpSaving) return;
    const { byKey } = mrpIndex();
    const u = byKey[key];
    if (!u) return;
    const n = Math.round(Number(String(rawValue).replace(',', '.')));
    if (!Number.isFinite(n) || n < 0 || n > u.sets) {
        showAlert(`Số bộ đã xuất phải từ 0 đến ${u.sets}.`, 'error');
        renderMrpPanel();
        return;
    }
    if (n === unitIssued(u)) return;
    let change, msg;
    if (n === 0) {
        change = changeFor(u, MRP_ST.NEW);
        msg = `Đưa ${key} về 0 bộ đã xuất ("Chưa xử lý")?\n\nChỉ dùng khi nhập nhầm.`;
    } else if (n === u.sets) {
        change = changeFor(u, MRP_ST.DONE, n);
        msg = `Xác nhận ${key} đã xuất ĐỦ ${n}/${u.sets} bộ?`;
    } else {
        change = changeFor(u, MRP_ST.PART, n);
        msg = `Ghi nhận ${key} đã xuất ${n}/${u.sets} bộ?\n\nVật tư của ${u.sets - n} bộ còn lại vẫn được giữ chỗ.`;
    }
    showConfirm(msg, () => submitOrderStatusChanges([change], `✅ ${key}: đã xuất ${n}/${u.sets} bộ.`));
}

// ---------------------------------------------------------------------------
// HIỂN THỊ 2 TAB NHÁNH
// ---------------------------------------------------------------------------
function renderMrpPanel() {
    if (!document.getElementById('mrp-panel')) return;
    document.getElementById('btn-mrp-subtab-status').classList.toggle('active', mrpSubTab === 'status');
    document.getElementById('btn-mrp-subtab-pick').classList.toggle('active', mrpSubTab === 'pick');
    document.getElementById('mrp-sub-status').style.display = mrpSubTab === 'status' ? 'block' : 'none';
    document.getElementById('mrp-sub-pick').style.display = mrpSubTab === 'pick' ? 'block' : 'none';

    if (!mrpData) { setMrpStatus('🕒 Chưa tải dữ liệu bóc tách.', false, null); return; }
    setMrpStatus(`🕒 ${mrpData.lastRead ? 'Bóc tách cập nhật lúc ' + mrpData.lastRead : 'Chưa rõ thời điểm cập nhật bóc tách'} · Tồn kho theo lần tải gần nhất của trang`, false, null);

    const { units } = mrpIndex();
    const c = { NEW: 0, ACTIVE: 0, DONE: 0 };
    mrpData.orders.forEach(o => {
        const a = orderAggregate(o);
        if (a.status === MRP_ST.NEW) c.NEW++;
        else if (a.status === MRP_ST.DONE) c.DONE++;
        else c.ACTIVE++;   // Chờ xuất, Xuất một phần, hoặc lẫn nhiều trạng thái
    });
    document.getElementById('mrp-stats').innerHTML = `
        <div class="mrp-stat"><span>Tổng đơn · sản phẩm</span><b>${mrpData.orders.length}<small style="font-size:13px; color:var(--text-muted);"> · ${units.length}</small></b></div>
        <div class="mrp-stat"><span>Chưa xử lý</span><b>${c.NEW}</b></div>
        <div class="mrp-stat mrp-stat-warning"><span>Chờ / đang xuất</span><b>${c.ACTIVE}</b></div>
        <div class="mrp-stat mrp-stat-success"><span>Đã xuất đủ</span><b>${c.DONE}</b></div>`;

    if (mrpSubTab === 'status') renderMrpStatusTab();
    else renderMrpPickTab();
    renderMrpWarnings();
}

function orderMatchesFilter(o, filter) {
    if (!filter) return true;
    const a = orderAggregate(o);
    if (filter === MRP_ST.PART) return a.mixed || a.status === MRP_ST.PART;
    if (filter === MRP_ST.WAIT) return a.status === MRP_ST.WAIT || (o._units || []).some(u => unitStatus(u) === MRP_ST.WAIT);
    return a.status === filter;
}

function orderToggleCell(o) {
    const hasProducts = (o._units || []).some(u => u.isProduct);
    if (!hasProducts) return `<span style="display:inline-block; width:18px;"></span>${escapeHtml(o.key)}`;
    const open = mrpExpandedOrders.has(o.key);
    return `<button type="button" class="mrp-order-toggle" data-action="toggle-order" data-key="${escapeHtml(o.key)}" aria-expanded="${open}" aria-label="${open ? 'Thu gọn' : 'Mở'} sản phẩm của đơn ${escapeHtml(o.key)}">${open ? '▾' : '▸'} ${escapeHtml(o.key)}</button>`;
}

// Tab nhánh 1: trạng thái từng đơn, mở ra từng sản phẩm để nhập số bộ đã xuất.
function renderMrpStatusTab() {
    const canIssue = hasPermission('CONFIRM_ISSUED');
    const filter = document.getElementById('mrpStatusFilter').value;
    const term = normalizeMrpText(document.getElementById('mrpStatusSearch').value);
    const list = mrpData.orders.filter(o => orderMatchesFilter(o, filter) &&
        (!term || [o.key, o.product, o.project].concat((o._units || []).map(u => u.key + ' ' + u.name)).some(v => normalizeMrpText(v).includes(term))));

    document.getElementById('mrp-issue-bar').style.display = canIssue ? 'flex' : 'none';
    const selectable = list.filter(o => orderAggregate(o).status !== MRP_ST.DONE);
    const selectedVisible = selectable.filter(o => mrpSelectedForIssue.has(o.key)).length;
    const bulkBtn = document.getElementById('btn-mrp-bulk-issue');
    bulkBtn.disabled = mrpSelectedForIssue.size === 0;
    setMrpButtonBusy(bulkBtn, mrpSaving, `✔ Xác nhận Đã xuất đủ (${mrpSelectedForIssue.size} đơn đã chọn)`);
    const allBox = document.getElementById('mrpSelectAllIssue');
    allBox.checked = selectable.length > 0 && selectedVisible === selectable.length;
    allBox.disabled = selectable.length === 0 || mrpSaving;

    document.getElementById('mrpStatusHeadSelect').style.display = canIssue ? '' : 'none';
    document.getElementById('mrpStatusHeadAction').style.display = canIssue ? '' : 'none';
    const tbody = document.getElementById('mrpStatusBody');
    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="8" style="color:#94a3b8; padding:20px;">Không có đơn hàng nào khớp bộ lọc.</td></tr>`;
        return;
    }
    const dis = mrpSaving ? ' disabled' : '';
    tbody.innerHTML = list.map(o => {
        const agg = orderAggregate(o);
        const upd = unitLatestUpdate(o._units || []);
        const updated = upd ? `${escapeHtml(upd.by)}<br><span style="color:#94a3b8;">${escapeHtml(upd.at)}</span>` : '<span style="color:#94a3b8;">—</span>';
        const selectCell = canIssue
            ? `<td>${agg.status !== MRP_ST.DONE ? `<input type="checkbox" class="mrp-issue-check" aria-label="Chọn đơn ${escapeHtml(o.key)}" data-key="${escapeHtml(o.key)}"${mrpSelectedForIssue.has(o.key) ? ' checked' : ''}${dis}>` : ''}</td>` : '';
        const anyIssued = (o._units || []).some(u => [MRP_ST.DONE, MRP_ST.PART].includes(unitStatus(u)));
        const actionCell = canIssue ? `<td style="white-space:nowrap;">${[
            agg.status !== MRP_ST.DONE ? `<button type="button" class="btn-refresh mrp-action-btn" data-action="issue" data-key="${escapeHtml(o.key)}"${dis}>✔ Đã xuất đủ</button>` : '',
            anyIssued ? `<button type="button" class="btn-refresh mrp-action-btn" data-action="undo" data-key="${escapeHtml(o.key)}"${dis} title="Đưa mọi sản phẩm của đơn về Chưa xử lý">↩</button>` : ''
        ].join(' ')}</td>` : '';
        const orderRow = `
            <tr class="mrp-order-row">
                ${selectCell}
                <td class="text-left font-bold">${orderToggleCell(o)}</td>
                <td class="text-left">${escapeHtml(o.product)}</td>
                <td class="text-left mrp-project-cell">${escapeHtml(o.project)}</td>
                <td>${escapeHtml(o.date)}</td>
                <td>${orderBadge(o)}</td>
                <td style="font-size:12px;">${updated}</td>
                ${actionCell}
            </tr>`;
        if (!mrpExpandedOrders.has(o.key) || !(o._units || []).some(u => u.isProduct)) return orderRow;
        const productRows = o._units.map(u => {
            const issued = unitIssued(u);
            const input = canIssue && u.sets > 0
                ? `<span class="mrp-issued-edit"><span class="mrp-issued-label">Tổng đã xuất</span><input type="number" class="mrp-issued-input" min="0" max="${u.sets}" step="1" value="${issued}" data-key="${escapeHtml(u.key)}" aria-label="Tổng số bộ đã xuất (lũy kế) của ${escapeHtml(u.key)}" title="Gõ TỔNG số bộ đã xuất tính đến nay (cộng cả các đợt trước), không phải số của riêng đợt này"${dis}> / ${formatMrpQty(u.sets)} bộ
                   <span class="mrp-issued-remain${issued >= u.sets ? ' is-done' : ''}">${issued >= u.sets ? 'xong' : 'còn ' + formatMrpQty(u.sets - issued)}</span>
                   <button type="button" class="btn-refresh mrp-action-btn" data-action="save-issued" data-key="${escapeHtml(u.key)}"${dis}>Lưu</button>
                   ${issued < u.sets ? `<button type="button" class="btn-refresh mrp-action-btn" data-action="full-issued" data-key="${escapeHtml(u.key)}"${dis} title="Điền đủ ${u.sets} bộ">Đủ</button>` : ''}</span>`
                : `${formatMrpQty(issued)} / ${formatMrpQty(u.sets)} bộ · ${issued >= u.sets ? 'xong' : 'còn ' + formatMrpQty(u.sets - issued)}`;
            return `
            <tr class="mrp-product-row">
                ${canIssue ? '<td></td>' : ''}
                <td class="text-left" style="padding-left:34px;">${escapeHtml(u.key)}</td>
                <td class="text-left" colspan="2">${escapeHtml(u.name)}</td>
                <td style="white-space:nowrap;">${formatMrpQty(u.sets)} bộ</td>
                <td>${unitStatusBadge(u)}</td>
                <td style="font-size:12px;">${u.ref.statusAt ? `${escapeHtml(u.ref.statusBy)}<br><span style="color:#94a3b8;">${escapeHtml(u.ref.statusAt)}</span>` : '<span style="color:#94a3b8;">—</span>'}</td>
                ${canIssue ? `<td style="white-space:nowrap;">${input}</td>` : `<td style="display:none;"></td>`}
            </tr>`;
        }).join('');
        return orderRow + productRows;
    }).join('');
}

// Tab nhánh 2: tích đơn (cả đơn) hoặc từng sản phẩm vào Chờ xuất + bảng tổng hợp xem trước.
function renderMrpPickTab() {
    const canWait = hasPermission('EDIT_WAITING_LIST');
    const term = normalizeMrpText(document.getElementById('mrpPickSearch').value);
    const candidates = mrpData.orders.filter(o => (o._units || []).some(isUnitPickable) &&
        (!term || [o.key, o.product, o.project].concat((o._units || []).map(u => u.key + ' ' + u.name)).some(v => normalizeMrpText(v).includes(term))));

    const { units } = mrpIndex();
    const pendingCount = units.filter(u => mrpPendingWait.has(u.key) && effectiveUnitStatus(u) !== unitStatus(u)).length;
    document.getElementById('mrp-pick-actions').style.display = canWait ? 'flex' : 'none';
    document.getElementById('mrp-pick-readonly').style.display = canWait ? 'none' : 'block';
    const saveBtn = document.getElementById('btn-mrp-save-waiting');
    saveBtn.disabled = pendingCount === 0;
    setMrpButtonBusy(saveBtn, mrpSaving, pendingCount ? `💾 Lưu danh mục chờ (${pendingCount} thay đổi)` : '💾 Lưu danh mục chờ');
    const cancelBtn = document.getElementById('btn-mrp-cancel-waiting');
    cancelBtn.style.display = pendingCount ? '' : 'none';
    cancelBtn.disabled = mrpSaving;

    const lock = canWait && !mrpSaving ? '' : ' disabled';
    const body = document.getElementById('mrpPickBody');
    body.innerHTML = candidates.length === 0
        ? `<tr><td colspan="5" style="color:#94a3b8; padding:20px;">Không có đơn Chưa xử lý / Chờ xuất nào${term ? ' khớp bộ lọc' : ''}.</td></tr>`
        : candidates.map(o => {
            const pick = o._units.filter(isUnitPickable);
            const on = pick.filter(u => effectiveUnitStatus(u) === MRP_ST.WAIT).length;
            const changed = pick.some(u => effectiveUnitStatus(u) !== unitStatus(u));
            const orderRow = `
                <tr class="mrp-order-row${changed ? ' mrp-pending-row' : ''}">
                    <td><input type="checkbox" class="mrp-wait-check" data-scope="order" data-key="${escapeHtml(o.key)}" aria-label="Chờ xuất cả đơn ${escapeHtml(o.key)}"${on === pick.length ? ' checked' : ''}${on > 0 && on < pick.length ? ' data-indeterminate="1"' : ''}${lock}></td>
                    <td class="text-left font-bold">${orderToggleCell(o)}</td>
                    <td class="text-left">${escapeHtml(o.product)}</td>
                    <td class="text-left mrp-project-cell">${escapeHtml(o.project)}</td>
                    <td>${changed ? previewOrderBadge(o) + ' <span style="font-size:11px; color:var(--danger); font-weight:700;">chưa lưu</span>' : orderBadge(o)}</td>
                </tr>`;
            if (!mrpExpandedOrders.has(o.key) || !o._units.some(u => u.isProduct)) return orderRow;
            return orderRow + o._units.map(u => {
                const pickable = isUnitPickable(u);
                const eff = effectiveUnitStatus(u);
                const ch = pickable && eff !== unitStatus(u);
                return `
                <tr class="mrp-product-row${ch ? ' mrp-pending-row' : ''}">
                    <td>${pickable ? `<input type="checkbox" class="mrp-wait-check" data-scope="unit" data-key="${escapeHtml(u.key)}" aria-label="Chờ xuất ${escapeHtml(u.key)}"${eff === MRP_ST.WAIT ? ' checked' : ''}${lock}>` : ''}</td>
                    <td class="text-left" style="padding-left:34px;">${escapeHtml(u.key)}</td>
                    <td class="text-left" colspan="2">${escapeHtml(u.name)} <span style="color:#94a3b8;">· ${formatMrpQty(u.sets)} bộ</span></td>
                    <td>${pickable ? mrpStatusBadge(eff) : unitStatusBadge(u)}${ch ? ' <span style="font-size:11px; color:var(--danger); font-weight:700;">chưa lưu</span>' : ''}</td>
                </tr>`;
            }).join('');
        }).join('');
    // Ô tích "một phần sản phẩm được chọn" - thuộc tính indeterminate chỉ đặt được bằng JS.
    body.querySelectorAll('input[data-indeterminate="1"]').forEach(b => { b.indeterminate = true; });

    renderMrpWaitingSummary(pendingCount);
}

// Nhãn xem trước của dòng đơn khi có tích chưa lưu: tính theo trạng thái SẼ có sau khi lưu.
function previewOrderBadge(o) {
    const sts = (o._units || []).map(u => isUnitPickable(u) ? effectiveUnitStatus(u) : unitStatus(u));
    if (sts.length && sts.every(x => x === sts[0])) return mrpStatusBadge(sts[0]);
    const wait = sts.filter(x => x === MRP_ST.WAIT).length;
    return `<span class="badge badge-part">Một phần · ${wait}/${sts.length} SP chờ xuất</span>`;
}

function setPendingWait(u, want) {
    if (!isUnitPickable(u)) return;
    // Tích về đúng trạng thái đã lưu = không còn là thay đổi.
    if ((want ? MRP_ST.WAIT : MRP_ST.NEW) === unitStatus(u)) mrpPendingWait.delete(u.key);
    else mrpPendingWait.set(u.key, want);
}

// Mã vật tư đang THỰC SỰ có nhu cầu giữ (theo trạng thái ĐÃ LƯU: Chờ xuất + phần chưa xuất của Xuất một phần).
// Đơn bị hủy (xóa khỏi bóc tách), bỏ khỏi Chờ xuất hay đã xuất đủ -> mã của nó rơi khỏi tập này.
function activeDemandCodes() {
    const set = new Set();
    if (!mrpData) return set;
    const { units } = mrpIndex();
    const active = new Set(units.filter(u => unitReserveFactor(u, false) > MRP_EPSILON).map(u => u.key));
    (mrpData.productDemand || []).forEach(([pkey, , code]) => { if (code && active.has(pkey)) set.add(normalizeMrpCode(code)); });
    (mrpData.demand || []).forEach(([okey, code]) => { if (code && active.has(okey)) set.add(normalizeMrpCode(code)); });
    return set;
}

// Tấm đang giữ để tận dụng nhưng không còn tác dụng:
//   - "mồ côi": mã được giữ cho KHÔNG còn nhu cầu (đơn hủy / bỏ chờ xuất / đã xuất đủ) -> nên bỏ giữ để người khác dùng;
//   - "đã xuất": tấm không còn trong kho (kế toán đã xuất) -> dòng giữ chỉ còn là rác, dọn cho gọn.
// Chỉ NHẮC, không tự bỏ giữ thay người dùng.
function staleReservations() {
    const active = activeDemandCodes();
    const stock = {};
    flatInventoryList.forEach(i => { if (!isPriceSheetName(i.sheet)) stock[normalizeMrpCode(i.id)] = (stock[normalizeMrpCode(i.id)] || 0) + accountingStockOf(i); });
    return ((mrpData && mrpData.reservations) || []).map(x => {
        const inStock = stock[normalizeMrpCode(x.remnant)] || 0;
        if (!(inStock > 0)) return Object.assign({ reason: 'used' }, x);
        if (!active.has(normalizeMrpCode(x.target))) return Object.assign({ reason: 'orphan' }, x);
        return null;
    }).filter(Boolean);
}

function renderMrpStaleReservations() {
    const box = document.getElementById('mrp-stale-res');
    if (!box) return;
    const list = mrpData ? staleReservations() : [];
    if (!list.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
    const can = hasPermission('RESERVE_REMNANT');
    const dis = mrpSaving ? ' disabled' : '';
    const orphan = list.filter(x => x.reason === 'orphan').length;
    box.style.display = 'block';
    box.innerHTML = `<div class="mrp-stale-head">⚠ Tấm đang giữ nhưng không còn nhu cầu (${list.length})</div>
        <div style="font-size:12.5px; color:#64748b; margin-bottom:6px;">${orphan ? `${orphan} tấm giữ cho mã <b>không còn đơn nào cần</b> (đơn đã hủy / bỏ khỏi chờ xuất / đã xuất đủ) – nên bỏ giữ để mã khác dùng. ` : ''}Tấm đã xuất khỏi kho thì chỉ cần dọn dòng giữ.</div>
        <div class="table-container" style="margin-top:0;"><table class="mrp-detail-table"><thead><tr>
        <th class="text-left">Tấm</th><th class="text-left">Đang giữ cho mã</th><th class="text-right">SL</th><th class="text-left">Người giữ</th><th class="text-left">Tình trạng</th>${can ? '<th></th>' : ''}
        </tr></thead><tbody>${list.map(x => `<tr>
            <td class="text-left">${escapeHtml(x.remnant)}</td>
            <td class="text-left">${escapeHtml(x.target)}</td>
            <td class="text-right">${formatMrpQty(x.qty)}</td>
            <td class="text-left">${escapeHtml(x.by)}<br><span style="color:#94a3b8;">${escapeHtml(x.at)}</span></td>
            <td class="text-left">${x.reason === 'orphan' ? '<span class="badge badge-warning">Mã không còn nhu cầu</span>' : '<span class="badge badge-info">Tấm đã xuất khỏi kho</span>'}</td>
            ${can ? `<td><button type="button" class="btn-refresh mrp-action-btn" data-action="release-remnant" data-remnant="${escapeHtml(x.remnant)}" data-target="${escapeHtml(x.target)}"${dis}>Bỏ giữ</button></td>` : ''}
        </tr>`).join('')}</tbody></table></div>`;
}

function renderMrpWaitingSummary(pendingCount) {
    const result = computeWaitingNeeds(true);
    renderMrpStaleReservations();
    const term = normalizeMrpText(document.getElementById('mrpSearchInput').value);
    const onlyShort = document.getElementById('mrpOnlyShort').checked;
    const matchTerm = r => !term || normalizeMrpText(r.code).includes(term) || normalizeMrpText(r.name).includes(term)
        || r.orders.some(o => normalizeMrpText(o.orderKey).includes(term));
    const visibleRows = result.rows.filter(r => matchTerm(r) && (!onlyShort || r.shortage > 0));
    const visibleNoCode = result.noCodeRows.filter(matchTerm);
    lastMrpView = { rows: visibleRows, noCodeRows: visibleNoCode, orderKeys: result.orderKeys, pendingCount, filtered: !!term || onlyShort };

    const shortCount = result.rows.filter(r => r.shortage > 0).length;
    document.getElementById('mrp-summary-caption').innerHTML =
        `Tổng hợp vật tư đang giữ cho <b>${result.unitCount}</b> sản phẩm của <b>${result.orderCount}</b> đơn (Chờ xuất + phần chưa xuất): <b>${result.rows.length}</b> mã, trong đó <b style="color:var(--warning);">${shortCount}</b> mã không đủ tồn` +
        (result.noCodeRows.length ? `, <b>${result.noCodeRows.length}</b> vật tư chưa có mã` : '') +
        (pendingCount ? ` <span style="color:var(--danger); font-weight:700;">(đang xem trước, gồm ${pendingCount} thay đổi chưa lưu)</span>` : '');

    const tbody = document.getElementById('mrpTableBody');
    if (!visibleRows.length) {
        tbody.innerHTML = `<tr><td colspan="8" style="color:#94a3b8; padding:20px;">${
            result.orderCount === 0 ? 'Chưa có sản phẩm nào đang giữ vật tư (Chờ xuất / Xuất một phần).'
            : result.rows.length === 0 ? 'Các đơn Chờ xuất chưa có vật tư nào có mã kho.'
            : onlyShort && !term ? '✅ Tồn kho đủ cho mọi mã của các đơn Chờ xuất.' : 'Không có mã nào khớp bộ lọc.'}</td></tr>`;
    } else {
        tbody.innerHTML = visibleRows.map(r => {
            const open = mrpExpanded.has(r.code);
            const flags = [
                !r.inStockList ? (r.nameHintCode
                    ? `<span class="badge badge-warning" title="Mã bóc tách không có trong kho, nhưng kho có vật tư cùng tên với mã khác - kiểm tra lại mã trong sheet VT BT. Đang tính tồn = 0.">⚠ Kho có tên này với mã ${escapeHtml(r.nameHintCode)}</span>`
                    : '<span class="badge badge-info" title="Kho hiện không có mã này (báo cáo tồn kho kế toán không có dòng của mã) - tính tồn = 0, toàn bộ số chờ xuất là phần cần mua">Tồn 0 · kho chưa có</span>') : '',
                r.unitMismatch ? `<span class="badge badge-warning" title="ĐVT kho: ${escapeHtml(r.inStockList ? r.unit : '(không có)')} | ĐVT bóc tách theo đơn - ${escapeHtml(r.unitDetail)}. Sửa trong sheet VT BT rồi Tổng hợp lại các đơn này.">⚠ ĐVT khác</span>` : '',
                r.remnant ? (r.remnant.mineCount > 0
                    ? (() => { const pp = purchasePlan(r); return `<span class="badge badge-reuse-on" title="Đã chọn tận dụng ${formatMrpQty(r.remnant.mineCount)} tấm ≈ ${formatMrpQty(r.remnant.mineEq)} tấm ${r.remnant.fullSize}. Bấm dòng để xem / bỏ chọn.">♻ Tận dụng ${formatMrpQty(r.remnant.mineCount)} tấm ≈ ${formatMrpQty(r.remnant.mineEq)} tấm${r.shortage > 0 ? ` → mua ${formatMrpQty(pp.after)} thay vì ${formatMrpQty(pp.base)}` : ''}</span>`; })()
                    : [r.remnant.pieces ? `<span class="badge badge-reuse" title="Kho có ${formatMrpQty(r.remnant.pieces)} tấm lẻ dày ${r.remnant.thick}mm (mọi mác) ≈ ${formatMrpQty(r.remnant.equivSheets)} tấm ${r.remnant.fullSize}. Bấm dòng để xem và tích tấm muốn tận dụng.">♻ ${formatMrpQty(r.remnant.pieces)} tấm lẻ ≈ ${formatMrpQty(r.remnant.equivSheets)} tấm</span>` : '',
                       r.remnant.fullPieces ? `<span class="badge badge-alt" title="Kho có ${formatMrpQty(r.remnant.fullPieces)} tấm nguyên khác mã cùng dày ${r.remnant.thick}mm (khác mác hoặc khác khổ) ≈ ${formatMrpQty(r.remnant.fullEquiv)} tấm ${r.remnant.fullSize}. Chỉ là đề xuất - bấm dòng để xem.">⇄ ${formatMrpQty(r.remnant.fullPieces)} tấm nguyên khác mã ≈ ${formatMrpQty(r.remnant.fullEquiv)} tấm</span>` : ''].join(' ')) : '',
                r.reservedOut && r.reservedOut.length ? `<span class="badge badge-warning" title="${escapeHtml(r.reservedOut.map(x => x.qty + ' tấm giữ cho ' + x.target + ' · ' + x.by).join('; '))}">⚠ ${formatMrpQty(r.reservedOut.reduce((s, x) => s + (Number(x.qty) || 0), 0))} tấm đang giữ cho mã khác</span>` : '',
                r.transitSkipped.length ? `<span class="badge badge-warning" title="Có ${r.transitSkipped.length} dòng đang về ghi ĐVT ${escapeHtml(r.transitSkipped.map(t => t.unit).join(', '))} - khác ĐVT ${escapeHtml(r.unit)}, KHÔNG được cộng. Kiểm tra lại đơn mua.">⚠ Đi đường khác ĐVT</span>` : ''
            ].join(' ');
            const main = `
                <tr class="mrp-row${open ? ' is-open' : ''}" data-mrp-code="${escapeHtml(r.code)}">
                    <td class="text-left font-bold">${open ? '▾' : '▸'} ${escapeHtml(r.code)}</td>
                    <td class="text-left">${escapeHtml(r.name)} ${flags}</td>
                    <td>${escapeHtml(r.unit)}</td>
                    <td class="text-right">${formatMrpQty(r.stock)}</td>
                    <td class="text-right font-bold">${formatMrpQty(r.need)}</td>
                    <td class="text-right" style="color:var(--vh-blue-dark); font-weight:700;">${r.transit > 0 ? formatMrpQty(r.transit) : '<span style="color:#cbd5e1;">—</span>'}</td>
                    <td class="text-right font-bold" style="color:${r.remain < -MRP_EPSILON ? 'var(--warning)' : 'var(--vh-green-dark)'};">${formatMrpQty(Math.abs(r.remain) < MRP_EPSILON ? 0 : r.remain)}</td>
                    <td>${r.orders.length}</td>
                </tr>`;
            // Mã khớp kho -> hiện ĐVT kế toán cho mọi đơn (kế toán là chuẩn); chưa khớp mới hiện ĐVT từng đơn.
            const detail = open ? `<tr class="mrp-detail-row"><td colspan="8">${renderMrpOrderDetail(r.orders, r.inStockList ? r.unit : r.demandUnit, r.inStockList)}${renderMrpTransitDetail(r)}${renderMrpRemnantDetail(r)}</td></tr>` : '';
            return main + detail;
        }).join('');
    }

    document.getElementById('mrpNoCodeBody').innerHTML = visibleNoCode.length === 0
        ? `<tr><td colspan="4" style="color:#94a3b8; padding:14px;">${result.noCodeRows.length === 0 ? '✅ Không có vật tư chưa có mã trong các đơn Chờ xuất.' : 'Không có vật tư nào khớp bộ lọc.'}</td></tr>`
        : visibleNoCode.map(g => `
            <tr>
                <td class="text-left">${escapeHtml(g.name)}</td>
                <td>${escapeHtml(g.unit)}</td>
                <td class="text-right font-bold" style="color:var(--warning);">${formatMrpQty(g.need)}</td>
                <td class="text-left" style="font-size:12px;">${g.orders.map(o => `${escapeHtml(o.orderKey)}: ${formatMrpQty(o.qty)}`).join(' · ')}</td>
            </tr>`).join('');
}

function renderMrpOrderDetail(orders, unit, useStockUnit) {
    const lines = orders.map(o => `
        <tr>
            <td class="text-left font-bold">${escapeHtml(o.orderKey)}${o.partial ? `<br><span style="font-weight:600; font-size:11px; color:#8A5A00;">còn ${formatMrpQty(o.remainSets)}/${formatMrpQty(o.sets)} bộ</span>` : ''}</td>
            <td class="text-left">${escapeHtml(o.product)}</td>
            <td class="text-left mrp-project-cell">${escapeHtml(o.project)}</td>
            <td>${escapeHtml(o.date)}</td>
            <td class="text-right font-bold">${formatMrpQty(o.qty)} ${escapeHtml((useStockUnit ? unit : o.unit) || unit || '')}</td>
        </tr>`).join('');
    return `<table class="mrp-detail-table"><thead><tr>
        <th class="text-left">Mã ĐH</th><th class="text-left">Sản phẩm</th><th class="text-left">Dự án</th><th>Ngày BT</th><th class="text-right">SL chờ xuất</th>
        </tr></thead><tbody>${lines}</tbody></table>`;
}

// Chi tiết hàng đang về của 1 mã (khi mở dòng ở bảng tổng hợp) - để biết về từ đơn mua nào, bao giờ, có kịp không.
function renderMrpTransitDetail(r) {
    const list = r.transitRows.concat(r.transitSkipped);
    if (!list.length) return '';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const lines = list.map(t => {
        const skipped = r.transitSkipped.includes(t);
        const overdue = t.etaTs && t.etaTs < today.getTime();
        return `<tr style="${skipped ? 'opacity:0.55;' : ''}">
            <td class="text-left">${escapeHtml(t.sheet)} · dòng ${t.row}${t.request ? ' · YCMH ' + escapeHtml(t.request) : ''}</td>
            <td class="text-left">${escapeHtml(t.supplier || '—')}</td>
            <td class="text-left mrp-project-cell">${escapeHtml(t.ref || '')}</td>
            <td>${escapeHtml(t.eta || '—')}${overdue ? ' <span class="badge badge-danger">Quá hạn</span>' : ''}</td>
            <td class="text-right font-bold">${formatMrpQty(t.qty)} ${escapeHtml(t.unit || '')}${skipped ? ' <span class="badge badge-warning">khác ĐVT, không cộng</span>' : ''}</td>
        </tr>`;
    }).join('');
    return `<div style="margin-top:10px; font-size:12.5px; font-weight:700; color:var(--vh-blue-dark);">🚚 Hàng đang về</div>
        <table class="mrp-detail-table"><thead><tr>
        <th class="text-left">Nguồn</th><th class="text-left">NCC</th><th class="text-left">Phục vụ</th><th>Dự kiến về</th><th class="text-right">Còn về</th>
        </tr></thead><tbody>${lines}</tbody></table>`;
}

// Khi mở 1 mã thép tấm: 2 nhóm đề xuất cùng chiều dày - TẤM LẺ và TẤM NGUYÊN KHÁC MÃ. Tích (hoặc nhập số tấm)
// để tận dụng; chỉ tấm người dùng chủ động tích mới trừ vào "Mua sau tận dụng", không tích thì không ảnh hưởng gì.
function renderPlateSuggestTable(items, h, can, dis) {
    const shown = items.slice(0, 12);
    const lines = shown.map(x => {
        const attrs = `data-remnant="${escapeHtml(x.code)}" data-target="${escapeHtml(h.target)}"`;
        let control;
        if (!can) control = x.mine > 0 ? `<b>${formatMrpQty(x.mine)}</b> tấm` : '<span style="color:#94a3b8;">—</span>';
        else if (x.available === 0 && x.mineRaw === 0) control = '<span style="color:#94a3b8; font-size:12px;">đã giữ hết</span>';
        else if (x.qty === 1 && x.othersQty === 0) control = `<input type="checkbox" class="remnant-check" ${attrs} aria-label="Tận dụng tấm ${escapeHtml(x.code)}"${x.mine > 0 ? ' checked' : ''}${dis}>`;
        else control = `<span class="mrp-issued-edit"><input type="number" class="mrp-issued-input remnant-input" min="0" max="${x.available}" step="1" value="${x.mine}" ${attrs} aria-label="Số tấm ${escapeHtml(x.code)} muốn tận dụng"${dis}> / ${formatMrpQty(x.available)}
            <button type="button" class="btn-refresh mrp-action-btn" data-action="save-remnant" ${attrs}${dis}>Lưu</button></span>`;
        const held = x.others.map(o => `${formatMrpQty(o.qty)} tấm cho ${escapeHtml(o.target)} · ${escapeHtml(o.by)}${h.activeCodes && !h.activeCodes.has(normalizeMrpCode(o.target)) ? ' <span style="color:var(--danger); font-weight:700;">(mã không còn nhu cầu)</span>' : ''}`).join('<br>');
        return `<tr class="${x.mine > 0 ? 'remnant-on' : ''}">
            <td>${control}</td>
            <td class="text-left">${escapeHtml(x.code)}</td>
            <td class="text-left">${escapeHtml(x.grade)}${x.grade === h.grade ? '' : ' <span style="color:#94a3b8;">(khác mác)</span>'}</td>
            <td>${escapeHtml(x.sizeText)} × ${formatMrpQty(x.thick)}</td>
            <td class="text-right">${formatMrpQty(x.qty)}</td>
            <td class="text-right">${formatMrpQty(Math.round(x.kg * x.qty))} kg</td>
            <td class="text-left" style="font-size:11.5px; color:#64748b;">${held || ''}${x.over ? `<div style="color:var(--danger); font-weight:700;">Đang giữ ${formatMrpQty(x.mineRaw)} nhưng chỉ còn ${formatMrpQty(x.available)} tấm</div>` : ''}</td>
        </tr>`;
    }).join('');
    return `<table class="mrp-detail-table"><thead><tr>
        <th style="width:190px; white-space:nowrap;">Tận dụng</th><th class="text-left">Mã</th><th class="text-left">Mác</th><th>Kích thước</th><th class="text-right">Tồn</th><th class="text-right">KL ước tính</th><th class="text-left">Đang giữ cho mã khác</th>
        </tr></thead><tbody>${lines}</tbody></table>${items.length > shown.length ? `<div style="font-size:12px; color:#64748b; margin-top:4px;">… và ${items.length - shown.length} tấm khác.</div>` : ''}`;
}

function renderMrpRemnantDetail(r) {
    const h = r.remnant;
    if (!h) return '';
    h.activeCodes = activeDemandCodes();
    const can = hasPermission('RESERVE_REMNANT');
    const dis = mrpSaving ? ' disabled' : '';
    const pp = purchasePlan(r);
    const parts = [];
    if (h.list.length) parts.push(`<div style="margin-top:10px; font-size:12.5px; font-weight:700; color:var(--vh-green-dark);">♻ Tấm lẻ cùng chiều dày ${formatMrpQty(h.thick)} mm${can ? ' – tích tấm muốn tận dụng' : ''}</div>`
        + renderPlateSuggestTable(h.list, h, can, dis)
        + `<div style="font-size:12px; color:#64748b; margin-top:4px;">Còn trống ≈ ${formatMrpQty(Math.round(h.totalKg))} kg ≈ ${formatMrpQty(h.equivSheets)} tấm ${escapeHtml(h.fullSize)}. Tận dụng được bao nhiêu tùy kích thước chi tiết.</div>`);
    if (h.fullList.length) parts.push(`<div style="margin-top:12px; font-size:12.5px; font-weight:700; color:#16407A;">⇄ Tấm nguyên khác mã cùng chiều dày ${formatMrpQty(h.thick)} mm – dùng thay nếu mác / khổ phù hợp yêu cầu</div>`
        + renderPlateSuggestTable(h.fullList, h, can, dis)
        + `<div style="font-size:12px; color:#64748b; margin-top:4px;">≈ ${formatMrpQty(h.fullEquiv)} tấm ${escapeHtml(h.fullSize)}. Chỉ là đề xuất – dùng mác khác được hay không do người mua quyết định theo yêu cầu dự án, chứng chỉ vật liệu.</div>`);
    if (h.mineCount > 0) parts.push(`<div class="remnant-summary">♻ Đã chọn tận dụng <b>${formatMrpQty(h.mineCount)} tấm ≈ ${formatMrpQty(h.mineEq)} tấm ${escapeHtml(h.fullSize)}</b>${r.shortage > 0
        ? ` → <b>Mua sau tận dụng: ${formatMrpQty(pp.after)} ${escapeHtml(r.unit)}</b> (thay vì ${formatMrpQty(pp.base)})` : ' – mã này hiện không thiếu'}</div>`);
    return parts.join('') + `<div style="font-size:12px; color:#64748b; margin-top:4px;">Không tích thì số đề xuất mua giữ nguyên.</div>`;
}

// Lưu phần giữ tấm lẻ (qty = 0 là bỏ giữ). Gửi kèm SL đang thấy để máy chủ phát hiện người khác vừa đổi.
async function saveRemnant(remnant, target, qty) {
    if (!hasPermission('RESERVE_REMNANT') || !mrpData || mrpSaving) return;
    const n = Math.round(Number(String(qty).replace(',', '.')));
    if (!Number.isFinite(n) || n < 0) { showAlert('Số tấm tận dụng phải là số nguyên từ 0 trở lên.', 'error'); renderMrpPanel(); return; }
    const cur = (mrpData.reservations || []).find(x => normalizeMrpCode(x.remnant) === normalizeMrpCode(remnant) && normalizeMrpCode(x.target) === normalizeMrpCode(target));
    const fromQty = cur ? Number(cur.qty) || 0 : 0;
    if (n === fromQty) return;
    mrpSaving = true;
    renderMrpPanel();
    setMrpStatus('💾 Đang lưu tấm lẻ tận dụng...', false, null);
    try {
        const data = await apiPost('reserveRemnant', { token: currentUser.token, changes: [{ remnant, target, qty: n, fromQty }] });
        if (isUnauthorizedResponse(data)) return;
        if (!data || !data.success) { showAlert((data && data.error) || 'Chưa lưu được tấm lẻ tận dụng.', 'error'); return; }
        mrpData.reservations = data.reservations || [];
        setMrpStatus(n > 0 ? `♻ Đã giữ ${n} tấm ${remnant} để tận dụng cho ${target}.` : `♻ Đã bỏ tận dụng tấm ${remnant}.`, false, null);
    } catch (err) {
        console.error('Lỗi lưu tấm lẻ tận dụng:', err);
        showAlert('Không kết nối được máy chủ, chưa lưu được.', 'error');
    } finally {
        mrpSaving = false;
        renderMrpPanel();
    }
}

function renderMrpWarnings() {
    const counts = mrpData.warnCounts || {};
    const totalWarn = Object.values(counts).reduce((s, n) => s + n, 0);
    document.getElementById('mrp-warn-count').innerText = totalWarn;
    const warnList = mrpData.warnings || [];
    document.getElementById('mrp-warnings').innerHTML = totalWarn === 0
        ? '<p style="color:#94a3b8; font-size:13px;">✅ Không có cảnh báo nào.</p>'
        : `<p style="font-size:12.5px; color:#64748b; margin:8px 0;">${Object.keys(counts).map(k => `${escapeHtml(k)}: <b>${counts[k]}</b>`).join(' · ')}
            ${warnList.length < totalWarn ? ` — hiển thị ${warnList.length} dòng đầu, xem đủ trong sheet BOC_TACH_CANH_BAO` : ''}</p>
           <div class="table-responsive"><table class="mrp-detail-table"><thead><tr><th>Mức độ</th><th class="text-left">Mã ĐH</th><th>Sheet</th><th class="text-left">Nội dung</th></tr></thead><tbody>
           ${warnList.map(w => `<tr><td>${escapeHtml(w[0])}</td><td class="text-left">${escapeHtml(w[1])}</td><td>${escapeHtml(w[2])}</td><td class="text-left">${escapeHtml(w[3])}</td></tr>`).join('')}
           </tbody></table></div>`;
}

function toggleMrpRow(code) {
    if (mrpExpanded.has(code)) mrpExpanded.delete(code);
    else mrpExpanded.add(code);
    renderMrpPanel();
}

// Gắn sự kiện cho module - gọi 1 lần trong bindStaticUiEvents.
function bindMrpEvents(on) {
    on('btn-open-mrp', 'click', openMrpPanel);
    on('btn-open-transit', 'click', openTransitPanel);
    on('chkWaitingStock', 'change', () => toggleStockAdjust('waiting'));
    on('chkTransitStock', 'change', () => toggleStockAdjust('transit'));
    on('btn-transit-reload', 'click', loadMrpData);
    on('transitSearch', 'input', renderTransitPanel);
    on('transitOnlyBt', 'change', renderTransitPanel);
    on('btn-export-transit', 'click', exportTransit);
    on('btn-mrp-reload', 'click', loadMrpData);
    on('btn-mrp-subtab-status', 'click', () => switchMrpSubTab('status'));
    on('btn-mrp-subtab-pick', 'click', () => switchMrpSubTab('pick'));
    on('mrpStatusFilter', 'change', renderMrpPanel);
    on('mrpStatusSearch', 'input', renderMrpPanel);
    on('mrpPickSearch', 'input', renderMrpPanel);
    on('mrpSearchInput', 'input', renderMrpPanel);
    on('mrpOnlyShort', 'change', renderMrpPanel);
    on('btn-mrp-save-waiting', 'click', saveWaitingList);
    on('btn-mrp-cancel-waiting', 'click', cancelWaitingChanges);
    on('btn-export-mrp', 'click', exportMrp);
    on('btn-mrp-bulk-issue', 'click', () => confirmIssued(Array.from(mrpSelectedForIssue)));
    on('mrpSelectAllIssue', 'change', (e) => {
        // Chọn/bỏ chọn tất cả đơn ĐANG HIỂN THỊ (theo bộ lọc) chưa Đã xuất.
        document.querySelectorAll('#mrpStatusBody .mrp-issue-check').forEach(box => {
            if (e.target.checked) mrpSelectedForIssue.add(box.dataset.key);
            else mrpSelectedForIssue.delete(box.dataset.key);
        });
        renderMrpPanel();
    });

    const statusBody = document.getElementById('mrpStatusBody');
    if (statusBody) {
        statusBody.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn || btn.disabled) return;
            const key = btn.dataset.key;
            if (btn.dataset.action === 'toggle-order') {
                if (mrpExpandedOrders.has(key)) mrpExpandedOrders.delete(key); else mrpExpandedOrders.add(key);
                renderMrpPanel();
            } else if (btn.dataset.action === 'issue') confirmIssued([key]);
            else if (btn.dataset.action === 'undo') undoIssued(key);
            else if (btn.dataset.action === 'save-issued') {
                const input = statusBody.querySelector(`.mrp-issued-input[data-key="${CSS.escape(key)}"]`);
                if (input) saveUnitIssued(key, input.value);
            } else if (btn.dataset.action === 'full-issued') {
                const { byKey } = mrpIndex();
                if (byKey[key]) saveUnitIssued(key, byKey[key].sets);
            }
        });
        statusBody.addEventListener('keydown', (e) => {
            // Gõ số rồi Enter = Lưu (không bắt phím toàn trang - chỉ trong ô nhập số bộ).
            const input = e.target.closest('.mrp-issued-input');
            if (input && e.key === 'Enter') { e.preventDefault(); saveUnitIssued(input.dataset.key, input.value); }
        });
        statusBody.addEventListener('change', (e) => {
            const box = e.target.closest('.mrp-issue-check');
            if (!box) return;
            if (box.checked) mrpSelectedForIssue.add(box.dataset.key);
            else mrpSelectedForIssue.delete(box.dataset.key);
            renderMrpPanel();
        });
    }
    const pickBody = document.getElementById('mrpPickBody');
    if (pickBody) {
        pickBody.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action="toggle-order"]');
            if (!btn) return;
            const key = btn.dataset.key;
            if (mrpExpandedOrders.has(key)) mrpExpandedOrders.delete(key); else mrpExpandedOrders.add(key);
            renderMrpPanel();
        });
        pickBody.addEventListener('change', (e) => {
            const box = e.target.closest('.mrp-wait-check');
            if (!box || !hasPermission('EDIT_WAITING_LIST') || mrpSaving) return;
            const { byKey } = mrpIndex();
            if (box.dataset.scope === 'order') {
                // Tích cả đơn = áp cho mọi sản phẩm còn tích được của đơn.
                const o = mrpData.orders.find(x => x.key === box.dataset.key);
                if (o) o._units.forEach(u => setPendingWait(u, box.checked));
            } else if (byKey[box.dataset.key]) {
                setPendingWait(byKey[box.dataset.key], box.checked);
            }
            renderMrpPanel();
        });
    }
    const staleBox = document.getElementById('mrp-stale-res');
    if (staleBox) {
        staleBox.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action="release-remnant"]');
            if (btn && !btn.disabled) saveRemnant(btn.dataset.remnant, btn.dataset.target, 0);
        });
    }
    const mrpBody = document.getElementById('mrpTableBody');
    if (mrpBody) {
        mrpBody.addEventListener('click', (e) => {
            const saveBtn = e.target.closest('[data-action="save-remnant"]');
            if (saveBtn) {
                const input = saveBtn.parentElement.querySelector('.remnant-input');
                if (input) saveRemnant(saveBtn.dataset.remnant, saveBtn.dataset.target, input.value);
                return;
            }
            const row = e.target.closest('tr[data-mrp-code]');
            if (row) toggleMrpRow(row.dataset.mrpCode);
        });
        mrpBody.addEventListener('change', (e) => {
            const box = e.target.closest('.remnant-check');
            if (box) saveRemnant(box.dataset.remnant, box.dataset.target, box.checked ? 1 : 0);
        });
        mrpBody.addEventListener('keydown', (e) => {
            const input = e.target.closest('.remnant-input');
            if (input && e.key === 'Enter') { e.preventDefault(); saveRemnant(input.dataset.remnant, input.dataset.target, input.value); }
        });
    }
}

// Đơn vị đếm nguyên chiếc (tấm, cây, cái, bộ...) -> đề xuất mua làm tròn LÊN số nguyên (0,54 tấm thì phải mua 1 tấm).
// Đơn vị đo liên tục (kg, m, lít...) giữ số lẻ, chỉ làm tròn lên 2 chữ số.
const MRP_WHOLE_UNITS = new Set(['chiec', 'tam', 'cay', 'bo', 'cuon', 'binh', 'tuyp', 'tuyt', 'lo', 'hop', 'thanh', 'hat', 'tui', 'bao', 'chai', 'cot', 'thung', 'doi', 'set']);
function roundUpPurchase(qty, unit) {
    if (!(qty > 0)) return 0;
    if (MRP_WHOLE_UNITS.has(normalizeMrpUnit(unit))) return Math.ceil(qty - 1e-9);
    return Math.ceil(qty * 100 - 1e-9) / 100;
}

// Mẫu "Đề xuất mua vật tư" do app tự tạo (chưa theo mẫu YCMH riêng của Mua hàng - khi họ cần thì chỉnh sau).
// Thư viện Excel bản miễn phí không tô màu/in đậm được, nên bố cục dựa vào dòng tiêu đề, gộp ô và độ rộng cột.
function exportMrp() {
    if (!hasPermission('VIEW_MRP')) return;
    if (typeof XLSX === 'undefined') {
        showAlert('Không tải được thư viện xuất Excel (có thể do mất mạng). Anh thử tải lại trang rồi bấm lại giúp em.', 'error');
        return;
    }
    if (!lastMrpView || (lastMrpView.rows.length === 0 && lastMrpView.noCodeRows.length === 0)) {
        showAlert('Không có dữ liệu vật tư chờ xuất nào để xuất với bộ lọc hiện tại.', 'error');
        return;
    }
    const round = n => Math.round(Number(n) * 1000) / 1000;
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const nowText = `${pad(now.getHours())}:${pad(now.getMinutes())} ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const noteOf = r => [
        !r.inStockList ? (r.nameHintCode ? `Lệch mã - kho có tên này với mã ${r.nameHintCode}` : 'Kho chưa có mã này') : '',
        r.unitMismatch ? `ĐVT lệch - kho: ${r.inStockList ? r.unit : '(không có)'}; bóc tách: ${r.unitDetail}` : '',
        r.transitSkipped.length ? `Có ${r.transitSkipped.length} dòng đi đường khác ĐVT, không cộng` : '',
        r.transitRows.some(t => t.etaTs && t.etaTs < today.getTime()) ? 'Có hàng đi đường quá ngày dự kiến' : '',
        r.remnant ? (r.remnant.mineCount > 0
            ? `Tận dụng: ${r.remnant.list.concat(r.remnant.fullList).filter(x => x.mine > 0).map(x => x.code + ' ×' + x.mine).join(', ')} ≈ ${round(r.remnant.mineEq)} tấm ${r.remnant.fullSize}`
            : [r.remnant.pieces ? `Tham khảo: kho có ${round(r.remnant.pieces)} tấm lẻ cùng dày ≈ ${round(r.remnant.equivSheets)} tấm ${r.remnant.fullSize}` : '',
               r.remnant.fullPieces ? `${round(r.remnant.fullPieces)} tấm nguyên khác mã cùng dày ≈ ${round(r.remnant.fullEquiv)} tấm` : ''].filter(Boolean).join('; ') + ' - cân nhắc mua bớt') : '',
        r.reservedOut && r.reservedOut.length ? `${r.reservedOut.reduce((s, x) => s + (Number(x.qty) || 0), 0)} tấm của mã này đang giữ cho ${r.reservedOut.map(x => x.target).join(', ')}` : ''
    ].filter(Boolean).join('; ');

    // ---------- Sheet 1: ĐỀ XUẤT MUA (chỉ mã còn thiếu SAU KHI đã cộng hàng đi đường) ----------
    const shortRows = lastMrpView.rows.filter(r => r.shortage > 0);
    const HEAD = ['STT', 'Mã vật tư', 'Tên vật tư', 'ĐVT', 'Tồn kế toán', 'Chờ xuất', 'Đi đường', 'Thiếu', 'Đề xuất mua', 'Mua sau tận dụng', 'Phục vụ đơn', 'Ghi chú'];
    const aoa = [
        ['ĐỀ XUẤT MUA VẬT TƯ - THEO ĐƠN HÀNG CHỜ XUẤT'],
        [`Ngày lập: ${nowText}     Người lập: ${(currentUser && (currentUser.name || currentUser.email)) || ''}`],
        [`Căn cứ: ${lastMrpView.orderKeys.length} sản phẩm/đơn đang giữ vật tư (${lastMrpView.orderKeys.join(', ')})` +
            (lastMrpView.pendingCount ? ` - GỒM ${lastMrpView.pendingCount} thay đổi CHƯA LƯU` : '') +
            (lastMrpView.filtered ? ' - theo bộ lọc đang xem trên app' : '')],
        ['Thiếu = Chờ xuất − Tồn kế toán − Đi đường. Đề xuất mua: làm tròn lên với đơn vị đếm (tấm, cây, cái, bộ...). Mua sau tận dụng: đã trừ phần tấm lẻ người mua chọn tận dụng.'],
        [],
        HEAD
    ];
    let stt = 0;
    shortRows.forEach(r => { const pp = purchasePlan(r); aoa.push([++stt, r.code, r.name, r.unit, round(r.stock), round(r.need), round(r.transit),
        round(r.shortage), pp.base, pp.after, r.orders.map(o => o.orderKey).join(', '), noteOf(r)]); });
    // Vật tư chưa có mã: kho chưa từng có, không có hàng đi đường khớp được -> cần mua toàn bộ.
    lastMrpView.noCodeRows.forEach(g => aoa.push([++stt, '(chưa có mã)', g.name, g.unit, 0, round(g.need), 0,
        round(g.need), roundUpPurchase(g.need, g.unit), roundUpPurchase(g.need, g.unit), g.orders.map(o => o.orderKey).join(', '), 'Vật tư chưa có mã kho - kiểm tra VT BT']));
    if (!stt) aoa.push(['', '', '✅ Không có vật tư nào cần mua thêm - tồn kho và hàng đi đường đủ cho các đơn Chờ xuất.']);
    aoa.push([], [], ['', 'Người lập', '', '', 'Trưởng phòng KH - MH', '', '', '', 'Giám đốc']);
    const ws1 = XLSX.utils.aoa_to_sheet(aoa);
    ws1['!merges'] = [0, 1, 2, 3].map(r => ({ s: { r, c: 0 }, e: { r, c: HEAD.length - 1 } }));
    ws1['!cols'] = [5, 14, 40, 7, 11, 10, 10, 10, 11, 13, 22, 44].map(w => ({ wch: w }));

    // ---------- Sheet 2: cân đối đầy đủ như trên màn hình ----------
    const summary = lastMrpView.rows.map(r => ({
        'Mã Vật Tư': r.code, 'Tên Vật Tư': r.name, 'ĐVT': r.unit,
        'Tồn Kế Toán': round(r.stock), 'Chờ Xuất': round(r.need), 'Đi Đường': round(r.transit), 'Còn Lại': round(r.remain),
        'Số Đơn': r.orders.length, 'Ghi Chú': noteOf(r)
    }));
    lastMrpView.noCodeRows.forEach(g => summary.push({
        'Mã Vật Tư': '(chưa có mã)', 'Tên Vật Tư': g.name, 'ĐVT': g.unit, 'Tồn Kế Toán': 0, 'Chờ Xuất': round(g.need),
        'Đi Đường': 0, 'Còn Lại': -round(g.need), 'Số Đơn': g.orders.length, 'Ghi Chú': 'Vật tư chưa có mã kho'
    }));
    const ws2 = XLSX.utils.json_to_sheet(summary);
    ws2['!cols'] = [14, 42, 7, 12, 11, 11, 11, 8, 45].map(w => ({ wch: w }));

    // ---------- Sheet 3: chi tiết từng cặp đơn × vật tư ----------
    const detail = [];
    lastMrpView.rows.forEach(r => r.orders.forEach(o => detail.push({
        'Mã ĐH': o.orderKey, 'Mã Vật Tư': r.code, 'Tên Vật Tư': r.name, 'ĐVT': r.inStockList ? r.unit : (o.unit || r.demandUnit), 'SL Chờ Xuất': round(o.qty), 'Sản Phẩm': o.product, 'Dự Án': o.project
    })));
    lastMrpView.noCodeRows.forEach(g => g.orders.forEach(o => detail.push({
        'Mã ĐH': o.orderKey, 'Mã Vật Tư': '(chưa có mã)', 'Tên Vật Tư': g.name, 'ĐVT': g.unit, 'SL Chờ Xuất': round(o.qty), 'Sản Phẩm': o.product, 'Dự Án': o.project
    })));
    const ws3 = XLSX.utils.json_to_sheet(detail);
    ws3['!cols'] = [9, 14, 42, 7, 12, 22, 50].map(w => ({ wch: w }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, ws1, 'De xuat mua');
    if (summary.length) XLSX.utils.book_append_sheet(workbook, ws2, 'Can doi day du');
    if (detail.length) XLSX.utils.book_append_sheet(workbook, ws3, 'Chi tiet theo don');
    XLSX.writeFile(workbook, `DeXuatMuaVatTu_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.xlsx`);
}

// ============================================================================
// KHỞI ĐỘNG ỨNG DỤNG
// ----------------------------------------------------------------------------
// Chỉ gọi sau khi TOÀN BỘ file đã được thực thi và mọi biến/hàm phía trên đã được khởi tạo.
// Đây là điểm khởi động duy nhất của app.js.
// ============================================================================
initApp();
