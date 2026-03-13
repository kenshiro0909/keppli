/**
 * Google Docs 画像保存 - Content Script
 *
 * Googleドキュメントの画像を右クリックしたときの
 * コンテキストメニューに「名前を付けて画像を保存」を注入する。
 * 画質劣化なし（元データをそのまま取得）。
 */
(() => {
  if (window.__gdocImgDLInjected) return;
  window.__gdocImgDLInjected = true;

  // =========================================
  // SVG アイコン定義
  // =========================================
  const ICON_DOWNLOAD = `
    <svg viewBox="0 0 24 24">
      <path d="M5 20h14v-2H5v2zm7-18v12.17l3.59-3.58L17 12l-5 5-5-5 
               1.41-1.41L12 14.17V2z"/>
    </svg>`;

  const ICON_PNG = `
    <svg viewBox="0 0 24 24">
      <path d="M21 3H3v18h18V3zm-2 16H5V5h14v14zm-6-8h2v2h-2v2h-2v-2H9v-2h2V9h2v2z"/>
    </svg>`;

  // =========================================
  // 状態管理
  // =========================================
  let currentTargetImage = null;

  // =========================================
  // ユーティリティ
  // =========================================

  /**
   * トースト通知を表示
   */
  function showToast(message) {
    let toast = document.querySelector('.gdoc-img-dl-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'gdoc-img-dl-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 3000);
  }

  /**
   * MIME type → 拡張子
   */
  function mimeToExt(mime) {
    if (!mime) return 'png';
    if (mime.includes('png'))  return 'png';
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    if (mime.includes('gif'))  return 'gif';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('svg'))  return 'svg';
    if (mime.includes('bmp'))  return 'bmp';
    if (mime.includes('tiff')) return 'tiff';
    return 'png';
  }

  /**
   * ドキュメントタイトルを取得してファイル名のベースにする
   */
  function getDocTitle() {
    const titleEl = document.querySelector('.docs-title-input');
    const title = titleEl?.value?.trim() || 'gdoc_image';
    // ファイル名に使えない文字を除去
    return title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 50);
  }

  // =========================================
  // 画像データ取得（劣化なし）
  // =========================================

  /**
   * googleusercontent URL のサイズ制限パラメータを除去して
   * オリジナルサイズ（=s0）で取得する
   */
  function toOriginalUrl(src) {
    if (!src.includes('googleusercontent.com')) return src;
    let url = src;
    // =wXXX-hYYY / =sXXX を =s0 に置換
    url = url.replace(/=w\d+(-h\d+)?(-[a-z]+)*$/, '=s0');
    url = url.replace(/=s\d+$/, '=s0');
    if (!url.includes('=s0')) {
      url += '=s0';
    }
    return url;
  }

  /**
   * 画像を Blob として取得（オリジナル画質）
   */
  async function fetchImageBlob(imgEl) {
    const src = imgEl.src || '';

    // ---- Pattern A: blob: URL → fetch で元データ取得 ----
    if (src.startsWith('blob:')) {
      try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        if (blob.size > 0 && blob.type.startsWith('image/')) {
          return blob;
        }
      } catch (e) {
        console.warn('[GDocImgDL] blob fetch failed, trying canvas', e);
      }

      // Canvas フォールバック（PNG ロスレス出力）
      return new Promise((resolve) => {
        const w = imgEl.naturalWidth || imgEl.width;
        const h = imgEl.naturalHeight || imgEl.height;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imgEl, 0, 0, w, h);
        canvas.toBlob(resolve, 'image/png');
      });
    }

    // ---- Pattern B: googleusercontent URL → 最大解像度で取得 ----
    const originalUrl = toOriginalUrl(src);
    try {
      const resp = await fetch(originalUrl, { credentials: 'include' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.blob();
    } catch (e) {
      console.warn('[GDocImgDL] URL fetch failed', e);
    }

    // ---- 最終フォールバック: 通常 URL で取得 ----
    try {
      const resp = await fetch(src, { credentials: 'include' });
      return await resp.blob();
    } catch (e) {
      return null;
    }
  }

  /**
   * 指定形式に変換して Blob を返す（PNG→JPG等）
   * 'original' ならそのまま返す
   */
  async function convertBlob(blob, format) {
    if (format === 'original') return blob;

    const mimeMap = {
      'png':  'image/png',
      'jpg':  'image/jpeg',
      'webp': 'image/webp',
    };
    const targetMime = mimeMap[format];
    if (!targetMime) return blob;

    // 既に同じ形式ならそのまま
    if (blob.type === targetMime) return blob;

    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((newBlob) => {
          URL.revokeObjectURL(url);
          resolve(newBlob || blob);
        }, targetMime, 1.0); // 品質 1.0 = 最大
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(blob);
      };
      img.src = url;
    });
  }

  /**
   * Blob をダウンロード
   */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /**
   * ダウンロード実行（メインフロー）
   */
  async function handleDownload(imgEl, format = 'original') {
    try {
      showToast('? 画像を取得中...');

      const blob = await fetchImageBlob(imgEl);
      if (!blob) {
        showToast('? 画像の取得に失敗しました');
        return;
      }

      const finalBlob = await convertBlob(blob, format);
      const ext = (format === 'original') ? mimeToExt(finalBlob.type) : format;
      const title = getDocTitle();
      const timestamp = Date.now();
      const filename = `${title}_${timestamp}.${ext}`;

      downloadBlob(finalBlob, filename);

      const kb = (finalBlob.size / 1024).toFixed(1);
      showToast(`? 保存しました (${kb} KB)`);
    } catch (e) {
      console.error('[GDocImgDL]', e);
      showToast('? エラーが発生しました');
    }
  }

  // =========================================
  // Google Docs のコンテキストメニューに注入
  // =========================================

  /**
   * 右クリックされた要素が画像かどうか判定
   */
  function findTargetImage(el) {
    // 直接 <img> タグ
    if (el.tagName === 'IMG' && el.naturalWidth > 10) return el;

    // 親要素をたどって画像コンテナを探す
    let node = el;
    for (let i = 0; i < 6; i++) {
      if (!node) break;
      const img = node.querySelector?.('img');
      if (img && img.naturalWidth > 10) return img;
      node = node.parentElement;
    }
    return null;
  }

  /**
   * Google Docs の右クリックメニュー（.docs-menu-attached）が
   * DOM に出現するのを監視し、画像用メニュー項目を注入する
   */
  function injectMenuItems(contextMenu) {
    // 既に注入済みなら無視
    if (contextMenu.querySelector('.gdoc-img-dl-item')) return;
    if (!currentTargetImage) return;

    const img = currentTargetImage;
    const w = img.naturalWidth;
    const h = img.naturalHeight;

    // ---- セパレータ ----
    const sep = document.createElement('div');
    sep.className = 'gdoc-img-dl-separator';

    // ---- メイン項目: 名前を付けて画像を保存 ----
    const mainItem = document.createElement('div');
    mainItem.className = 'gdoc-img-dl-item';
    mainItem.innerHTML = `
      <span class="gdoc-img-dl-icon">${ICON_DOWNLOAD}</span>
      <span class="gdoc-img-dl-label">名前を付けて画像を保存</span>
      <span class="gdoc-img-dl-submenu-arrow">?</span>
      <div class="gdoc-img-dl-submenu">
        <div class="gdoc-img-dl-sub-item" data-format="original">
          <span>オリジナル形式で保存</span>
          <span class="gdoc-img-dl-meta">${w} × ${h}</span>
        </div>
        <div class="gdoc-img-dl-sub-item" data-format="png">
          <span>PNG で保存</span>
          <span class="gdoc-img-dl-meta">ロスレス</span>
        </div>
        <div class="gdoc-img-dl-sub-item" data-format="jpg">
          <span>JPG で保存（最高品質）</span>
          <span class="gdoc-img-dl-meta">品質 100%</span>
        </div>
        <div class="gdoc-img-dl-sub-item" data-format="webp">
          <span>WebP で保存</span>
          <span class="gdoc-img-dl-meta">高圧縮</span>
        </div>
      </div>
    `;

    // サブメニュークリックハンドラ
    mainItem.querySelectorAll('.gdoc-img-dl-sub-item').forEach(item => {
      item.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const format = item.dataset.format;
        // メニューを閉じる
        contextMenu.style.display = 'none';
        handleDownload(img, format);
      });
    });

    // ---- クイック保存（オリジナル形式、1クリック） ----
    const quickItem = document.createElement('div');
    quickItem.className = 'gdoc-img-dl-item';
    quickItem.innerHTML = `
      <span class="gdoc-img-dl-icon">${ICON_PNG}</span>
      <span class="gdoc-img-dl-label">画像をすぐに保存（オリジナル画質）</span>
    `;
    quickItem.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      contextMenu.style.display = 'none';
      handleDownload(img, 'original');
    });

    // ---- メニューに追加 ----
    contextMenu.appendChild(sep);
    contextMenu.appendChild(quickItem);
    contextMenu.appendChild(mainItem);
  }

  // =========================================
  // 右クリック検知 & メニュー監視
  // =========================================

  /**
   * mousedown（右クリック）でターゲット画像を記録
   */
  document.addEventListener('mousedown', (e) => {
    if (e.button === 2) { // 右クリック
      currentTargetImage = findTargetImage(e.target);
    }
  }, true);

  /**
   * MutationObserver で Google Docs のコンテキストメニューの出現を監視。
   * Docs は独自の右クリックメニュー（.docs-menu-attached 等）を
   * 動的に生成するので、DOMの変化を検知して注入する。
   */
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;

        // Google Docs のコンテキストメニューを検出
        // パターン1: .goog-menu.goog-menu-vertical（メインメニュー）
        // パターン2: [role="menu"] 内の動的生成
        const menu = findContextMenu(node);
        if (menu && currentTargetImage) {
          // メニューのレンダリングを待ってから注入
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              injectMenuItems(menu);
            });
          });
        }
      }
    }
  });

  function findContextMenu(node) {
    // Docs の右クリックメニューは class に goog-menu を含む
    if (node.classList?.contains('goog-menu') &&
        node.classList?.contains('goog-menu-vertical')) {
      return node;
    }
    // 子要素にメニューがある場合
    return node.querySelector?.('.goog-menu.goog-menu-vertical');
  }

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // =========================================
  // 追加: Docs のキャンバスレンダリングモード対応
  //
  // 新しい Google Docs は canvas でレンダリングする場合がある。
  // その場合は img タグが存在しないため、
  // 「ウェブページとしてダウンロード → ZIP → 画像抽出」が必要。
  // ここでは従来の DOM ベースの Docs に対応。
  // =========================================

  console.log('[Google Docs 画像保存] 拡張機能を読み込みました');
})();
