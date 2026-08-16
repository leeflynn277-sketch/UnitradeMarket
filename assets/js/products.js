/* ============================================================
   Campus Market — static reference data + formatting helpers
   Prices in GH₵ (Ghana cedis). price = 0 means a free item.

   Actual listings now live in the SQLite backend (see /server) and
   are fetched through assets/js/api.js — this file only keeps the
   category taxonomy / safe-zone config (rarely-changing reference
   data) and small pure formatting helpers used across pages.
   ============================================================ */
const CM_CATEGORIES = [
    { key: 'books', label: 'Books & Stationery', bgImage: 'assets/images/books-stationery.jpg' },
    { key: 'electronics', label: 'Electronics & Gadgets', bgImage: 'assets/images/electronics-gadgets.jpg' },
    { key: 'fashion', label: 'Fashion & Accessories', bgImage: 'assets/images/fashion-accessories.jpg' },
    { key: 'sports', label: 'Sports & Fitness', bgImage: 'assets/images/sports-fitness.jpg' },
    { key: 'lab', label: 'Project & Lab Equipment', bgImage: 'assets/images/lab-equipment.jpg' },
    { key: 'misc', label: 'Miscellaneous', bgImage: 'assets/images/miscellaneous.jpg' },
];

const CM_SAFE_ZONES = [
    { id: 'uenr-library', name: 'UENR Library', sub: 'Main library building', hours: 'Open: 8:00 AM – 8:00 PM' },
    { id: 'cafeteria', name: 'Cafeteria', sub: 'Student dining hall', hours: 'Open: 7:00 AM – 7:00 PM' },
    { id: 'old-auditorium', name: 'Old Auditorium', sub: 'Main student hub', hours: 'Open: 9:00 AM – 6:00 PM' },
    { id: 'main-gate', name: 'Main Gate', sub: 'University entrance', hours: 'Open: 24/7 Security' },
];

function cmFormatPrice(price) {
    if (!price || price <= 0) return 'Free';
    return 'GH₵' + Number(price).toFixed(2);
}

function cmCategoryLabel(key) {
    const found = CM_CATEGORIES.find((c) => c.key === key);
    return found ? found.label : key;
}

function cmColorName(hex) {
    const names = { '#3B82F6': 'Blue', '#EF4444': 'Red', '#22C55E': 'Green', '#F59E0B': 'Orange' };
    return names[hex] || hex;
}
