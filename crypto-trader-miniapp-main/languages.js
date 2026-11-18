/* Additional UI languages. Missing strings intentionally fall back to English. */
(function () {
  const languages = {
    ur: ["اردو", "Urdu", "rtl"],
    es: ["Español", "Spanish", "ltr"],
    fr: ["Français", "French", "ltr"],
    de: ["Deutsch", "German", "ltr"],
    pt: ["Português", "Portuguese", "ltr"],
    ru: ["Русский", "Russian", "ltr"],
    zh: ["简体中文", "Chinese", "ltr"],
    ja: ["日本語", "Japanese", "ltr"],
    ko: ["한국어", "Korean", "ltr"],
    ar: ["العربية", "Arabic", "rtl"],
    tr: ["Türkçe", "Turkish", "ltr"],
    vi: ["Tiếng Việt", "Vietnamese", "ltr"],
    id: ["Bahasa Indonesia", "Indonesian", "ltr"],
    ms: ["Bahasa Melayu", "Malay", "ltr"],
    th: ["ไทย", "Thai", "ltr"],
    it: ["Italiano", "Italian", "ltr"],
    nl: ["Nederlands", "Dutch", "ltr"],
    pl: ["Polski", "Polish", "ltr"],
    uk: ["Українська", "Ukrainian", "ltr"],
    fa: ["فارسی", "Persian", "rtl"],
    sw: ["Kiswahili", "Swahili", "ltr"],
    ta: ["தமிழ்", "Tamil", "ltr"],
    te: ["తెలుగు", "Telugu", "ltr"],
    mr: ["मराठी", "Marathi", "ltr"]
  };

  const labels = {
    ur: ["زبان", "تبدیل کریں", "زبان تلاش کریں"],
    es: ["Idioma", "Cambiar", "Buscar idioma"],
    fr: ["Langue", "Modifier", "Rechercher une langue"],
    de: ["Sprache", "Ändern", "Sprache suchen"],
    pt: ["Idioma", "Alterar", "Pesquisar idioma"],
    ru: ["Язык", "Изменить", "Поиск языка"],
    zh: ["语言", "更改", "搜索语言"],
    ja: ["言語", "変更", "言語を検索"],
    ko: ["언어", "변경", "언어 검색"],
    ar: ["اللغة", "تغيير", "البحث عن لغة"],
    tr: ["Dil", "Değiştir", "Dil ara"],
    vi: ["Ngôn ngữ", "Thay đổi", "Tìm ngôn ngữ"],
    id: ["Bahasa", "Ubah", "Cari bahasa"],
    ms: ["Bahasa", "Tukar", "Cari bahasa"],
    th: ["ภาษา", "เปลี่ยน", "ค้นหาภาษา"],
    it: ["Lingua", "Cambia", "Cerca lingua"],
    nl: ["Taal", "Wijzigen", "Taal zoeken"],
    pl: ["Język", "Zmień", "Szukaj języka"],
    uk: ["Мова", "Змінити", "Пошук мови"],
    fa: ["زبان", "تغییر", "جستجوی زبان"],
    sw: ["Lugha", "Badilisha", "Tafuta lugha"],
    ta: ["மொழி", "மாற்று", "மொழியைத் தேடு"],
    te: ["భాష", "మార్చు", "భాషను వెతుకు"],
    mr: ["भाषा", "बदला", "भाषा शोधा"]
  };

  const extra = {};
  Object.keys(languages).forEach((code) => {
    const [name, en, dir] = languages[code];
    const [language, change, searchLang] = labels[code];
    extra[code] = {
      name, en, dir,
      s: { language, change, searchLang }
    };
  });
  window.CTP_LANGS_EXTRA = extra;
})();
