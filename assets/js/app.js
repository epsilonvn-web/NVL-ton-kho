// ==========================================================================
// APP.JS - Logic xử lý dữ liệu tồn kho NVL
// File này KHÔNG chứa giao diện (HTML/CSS) - toàn bộ giao diện nằm ở index.html
// ==========================================================================

// URL Google Apps Script API - lấy dữ liệu từ GGS "database" (đã IMPORTRANGE từ file kế toán)
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbx4VqKpT_h0suRstLds24ZQKPfvb7z9Mu7ZxVtsfYFpG3LN0j5j1AnOW5_d3DMXeuPE/exec";

// Dữ liệu demo dự phòng - dùng khi chưa gọi được GAS_API_URL
const DEMO_DATA = {
    "VẬT TƯ KHÁC": [
        { id: "SHPEL0002", name: "Chất đóng rắn sơn Hempaprime Multi 500-95090", unit: "Lít", tonCuoi: 192.45 },
        { id: "DRIN0410", name: "Đinh rút inox 4x10", unit: "Cái", tonCuoi: 9105 }
    ],
    "THÉP TẤM": [
        { id: "TPQ345B20", name: "Thép tấm Q345B dày 20mm", unit: "Kg", tonCuoi: 15400 },
        { id: "TSS40012", name: "Thép tấm SS400 dày 12mm", unit: "Kg", tonCuoi: 85000 }
    ]
};

let flatInventoryList = [];   // Danh sách gộp phẳng toàn bộ vật tư, mỗi item có thêm field "sheet" (tên danh mục)
let currentCategory = 'ALL';

document.addEventListener('DOMContentLoaded', fetchDataFromGoogleSheets);

// Gọi API lấy dữ liệu từ Google Sheets Database (qua Apps Script)
function fetchDataFromGoogleSheets() {
    fetch(GAS_API_URL)
        .then(response => {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
        })
        .then(data => {
            processData(data);
            toggleDemoBanner(false);
        })
        .catch(error => {
            console.error("Lỗi khi tải dữ liệu từ Google Sheets, dùng dữ liệu demo thay thế:", error);
            processData(DEMO_DATA);
            toggleDemoBanner(true);
        });
}

function toggleDemoBanner(isDemo) {
    const banner = document.getElementById('demo-banner');
    if (banner) banner.style.display = isDemo ? 'block' : 'none';
}

// Những giá trị id coi là "dòng tiêu đề bị lẫn vào dữ liệu" - cần loại bỏ, không phải vật tư thật.
const HEADER_LIKE_IDS = ['mã vật tư', 'ma vat tu', 'id', 'stt'];

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
    flatInventoryList = [];
    for (let sheetName in data) {
        const items = data[sheetName] || [];
        items.forEach(item => {
            if (isHeaderRow(item)) return; // bỏ qua dòng tiêu đề lẫn vào dữ liệu

            flatInventoryList.push({
                sheet: sheetName,
                id: item.id,
                name: item.name,
                unit: item.unit,
                stock: parseFloat(item.tonCuoi) || 0
            });
        });
    }

    renderCategoryTabs(Object.keys(data));
    renderTable();
}

// Sinh các nút tab danh mục dựa trên tên sheet thật có trong dữ liệu
function renderCategoryTabs(sheetNames) {
    const container = document.getElementById('nav-tabs-container');
    container.innerHTML = '';

    const allBtn = document.createElement('button');
    allBtn.className = 'nav-tab-btn active';
    allBtn.innerText = '📊 Dashboard Tổng';
    allBtn.onclick = function () { filterCategory('ALL', allBtn); };
    container.appendChild(allBtn);

    sheetNames.forEach(name => {
        const btn = document.createElement('button');
        btn.className = 'nav-tab-btn';
        btn.innerText = name;
        btn.onclick = function () { filterCategory(name, btn); };
        container.appendChild(btn);
    });

    document.getElementById('stat-categories').innerText = sheetNames.length;
}

function filterCategory(category, btnElement) {
    currentCategory = category;

    document.querySelectorAll('.nav-tab-btn').forEach(b => b.classList.remove('active'));
    if (btnElement) btnElement.classList.add('active');

    document.getElementById('panel-heading').innerText = category === 'ALL'
        ? '📦 Tồn Kho Nguyên Vật Liệu (Tất cả)'
        : `📦 Danh mục: ${category}`;

    renderTable();
}

function renderTable() {
    const searchTerm = (document.getElementById('searchInput').value || '').toLowerCase();
    const tbody = document.getElementById('inventory-table-body');
    tbody.innerHTML = '';

    const filteredData = flatInventoryList.filter(item => {
        const matchesSearch = item.id.toLowerCase().includes(searchTerm) || item.name.toLowerCase().includes(searchTerm);
        const matchesCategory = currentCategory === 'ALL' || item.sheet === currentCategory;
        return matchesSearch && matchesCategory;
    });

    if (filteredData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="color:#94a3b8; padding:20px;">Không tìm thấy vật tư phù hợp.</td></tr>`;
    }

    filteredData.forEach(item => {
        tbody.innerHTML += `
            <tr>
                <td class="text-left font-bold">${item.id}</td>
                <td class="text-left">${item.name}</td>
                <td>${item.unit}</td>
                <td class="text-right" style="font-weight:bold; font-size:15px; color:var(--vh-blue);">${item.stock.toLocaleString('en-US')}</td>
                <td class="text-left"><span class="badge badge-info">${item.sheet}</span></td>
            </tr>
        `;
    });

    document.getElementById('stat-total').innerText = filteredData.length;
}
