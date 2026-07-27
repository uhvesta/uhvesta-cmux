(function(global) {
  'use strict';

  var actionMotions = [
    ['diffViewerScrollDown', 'line', 1],
    ['diffViewerScrollUp', 'line', -1],
    ['diffViewerScrollHalfPageDown', 'halfPage', 1],
    ['diffViewerScrollHalfPageUp', 'halfPage', -1],
    ['diffViewerScrollDownEmacs', 'line', 1],
    ['diffViewerScrollUpEmacs', 'line', -1],
    ['diffViewerScrollToBottom', 'edge', 1],
    ['diffViewerScrollToTop', 'edge', -1]
  ];
  var smoothTargets = new WeakMap();
  var renderedRowSelections = new WeakMap();
  var renderedRowsCache = new WeakMap();
  var pendingRenderedRowMoves = new WeakMap();

  function normalizeStroke(raw) {
    return {
      key: String((raw && raw.key) || '').toLowerCase(),
      command: Boolean(raw && raw.command),
      control: Boolean(raw && raw.control),
      option: Boolean(raw && raw.option),
      shift: Boolean(raw && raw.shift)
    };
  }

  function normalizeShortcut(raw) {
    if (!raw || raw.unbound === true || !raw.first) { return null; }
    return {
      first: normalizeStroke(raw.first),
      second: raw.second ? normalizeStroke(raw.second) : null
    };
  }

  function eventKey(event) {
    if (event.code === 'Space') { return 'space'; }
    return typeof event.key === 'string' ? event.key.toLowerCase() : '';
  }

  function strokeMatches(stroke, event) {
    return Boolean(stroke) &&
      event.metaKey === stroke.command &&
      event.ctrlKey === stroke.control &&
      event.altKey === stroke.option &&
      event.shiftKey === stroke.shift &&
      eventKey(event) === stroke.key;
  }

  function isEditableTarget(target) {
    var element = target && target.closest ? target : null;
    return Boolean(element && element.closest("input, textarea, select, [contenteditable='true']"));
  }

  function isNativeScrollKey(event) {
    if (event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) { return false; }
    return ['arrowdown', 'arrowup', 'pagedown', 'pageup', 'home', 'end', 'space'].indexOf(eventKey(event)) >= 0;
  }

  function viewportHeight(scroller) {
    var height = Number(scroller && scroller.clientHeight);
    if (Number.isFinite(height) && height > 0) { return height; }
    return Math.max(1, Number(global.innerHeight) || 1);
  }

  function performAction(action, scroller) {
    var motion = actionMotions.find(function(entry) { return entry[0] === action; });
    if (!motion) { return false; }
    runMotion(scroller, motion[1], motion[2]);
    return true;
  }

  function resetSmoothTarget(scroller) {
    if (scroller) { smoothTargets.delete(scroller); }
  }

  // Pierre renders each visible file in its own shadow root. Walking those
  // roots gives j/k a row cursor over exactly the currently rendered rows,
  // including unchanged context in Full File mode, without defeating its
  // virtualization by asking for offscreen content.
  function itemIdForElement(element) {
    var current = element;
    while (current) {
      if (current.dataset && current.dataset.cmuxReviewItemId) {
        return current.dataset.cmuxReviewItemId;
      }
      if (current.parentElement) {
        current = current.parentElement;
        continue;
      }
      var root = current.getRootNode && current.getRootNode();
      current = root && root.host && (typeof HTMLElement === 'undefined' || root.host instanceof HTMLElement) ? root.host : null;
    }
    return undefined;
  }

  function collectRenderedRows(root) {
    if (!root || typeof root.querySelectorAll !== 'function') { return []; }
    var rows = [];
    var seen = new Set();
    function visit(node) {
      var direct = node.querySelectorAll('[data-line]');
      for (var i = 0; i < direct.length; i++) {
        var element = direct[i];
        if (seen.has(element)) { continue; }
        seen.add(element);
        var rect = element.getBoundingClientRect();
        if (rect.height > 0 || rect.width > 0) {
          rows.push({
            element: element,
            itemId: itemIdForElement(element),
            top: rect.top,
            bottom: rect.bottom
          });
        }
      }
      var descendants = node.querySelectorAll('*');
      for (var j = 0; j < descendants.length; j++) {
        if (descendants[j].shadowRoot) { visit(descendants[j].shadowRoot); }
      }
    }
    visit(root);
    rows.sort(function(left, right) { return left.top - right.top; });
    // Split diffs expose one DOM line on each side at the same visual row.
    // Keep one representative so each keypress advances a row, not a column.
    return rows.filter(function(row, index) {
      return index === 0 || Math.abs(row.top - rows[index - 1].top) > 0.5;
    });
  }

  // Pierre calls refreshRenderedRows after each virtual-window render. Motions
  // only read this bounded mounted-row snapshot; they never walk every shadow
  // root while handling a keystroke.
  function renderedRows(root) {
    if (!root) { return []; }
    var cached = renderedRowsCache.get(root);
    if (cached) { return cached; }
    cached = collectRenderedRows(root);
    renderedRowsCache.set(root, cached);
    return cached;
  }

  function refreshRenderedRows(root) {
    if (!root) { return false; }
    renderedRowsCache.set(root, collectRenderedRows(root));
    return resolvePendingRenderedRow(root);
  }

  function rowValue(row) {
    return {
      itemId: row.itemId,
      lineNumber: Number(row.element.getAttribute('data-line')) || 0,
      side: row.element.closest('[data-deletions]') ? 'deletions' : 'additions'
    };
  }

  function sameRow(left, right) {
    return left && right && left.itemId === right.itemId &&
      left.lineNumber === right.lineNumber && left.side === right.side;
  }

  function emitRenderedRowSelection(scroller, row) {
    var value = rowValue(row);
    renderedRowSelections.set(scroller, value);
    var ownerWindow = scroller.ownerDocument && scroller.ownerDocument.defaultView;
    if (ownerWindow && typeof ownerWindow.CustomEvent === 'function') {
      scroller.dispatchEvent(new ownerWindow.CustomEvent('cmux-diff-viewer-rendered-row-selected', {
        bubbles: true,
        detail: value
      }));
    }
    return value;
  }

  function selectedRowIndex(rows, selected, viewport) {
    if (selected) {
      for (var index = 0; index < rows.length; index++) {
        if (sameRow(rowValue(rows[index]), selected)) {
          return index;
        }
      }
    }
    for (var visibleIndex = 0; visibleIndex < rows.length; visibleIndex++) {
      if (rows[visibleIndex].bottom >= viewport.top + 1) {
        return visibleIndex;
      }
    }
    return 0;
  }

  function rowStep(rows, index) {
    var current = rows[index];
    var neighbor = rows[index + 1] || rows[index - 1];
    if (current && neighbor) {
      return Math.max(1, Math.abs(neighbor.top - current.top));
    }
    return Math.max(1, current ? current.bottom - current.top : 1);
  }

  function schedulePendingRenderedRowResolution(scroller) {
    var schedule = typeof global.requestAnimationFrame === 'function'
      ? global.requestAnimationFrame.bind(global)
      : function(callback) { return global.setTimeout(callback, 0); };
    schedule(function() {
      if (!resolvePendingRenderedRow(scroller)) {
        var pending = pendingRenderedRowMoves.get(scroller);
        if (pending && pending.attempts < 4) {
          pending.attempts += 1;
          schedulePendingRenderedRowResolution(scroller);
        }
      }
    });
  }

  // Pierre replaces a virtual window after scrolling. Resolve against the
  // replacement row, rather than retaining the last DOM row from the old
  // window as the comment cursor.
  function resolvePendingRenderedRow(scroller) {
    var pending = pendingRenderedRowMoves.get(scroller);
    if (!pending || !scroller) { return false; }
    var rows = renderedRows(scroller);
    if (rows.length === 0) { return false; }
    var viewport = scroller.getBoundingClientRect();
    var selected = renderedRowSelections.get(scroller);
    var index = selectedRowIndex(rows, selected, viewport);
    var target = rows[index + pending.direction];
    if (target && !sameRow(rowValue(target), pending.from)) {
      pendingRenderedRowMoves.delete(scroller);
      emitRenderedRowSelection(scroller, target);
      return true;
    }
    var visible = rows[selectedRowIndex(rows, null, viewport)];
    if (visible && !sameRow(rowValue(visible), pending.from)) {
      pendingRenderedRowMoves.delete(scroller);
      emitRenderedRowSelection(scroller, visible);
      return true;
    }
    return false;
  }

  function moveRenderedRow(scroller, direction) {
    if (!scroller) { return false; }
    if (pendingRenderedRowMoves.has(scroller)) { return { pending: true }; }
    var rows = renderedRows(scroller);
    if (rows.length === 0) { return false; }
    var viewport = scroller.getBoundingClientRect();
    var selected = renderedRowSelections.get(scroller);
    var current = selectedRowIndex(rows, selected, viewport);
    var targetIndex = current + direction;
    var target = rows[targetIndex];
    if (target) {
      resetSmoothTarget(scroller);
      var offset = target.top - viewport.top;
      scroller.scrollTo({ top: Math.max(0, (Number(scroller.scrollTop) || 0) + offset - 12), behavior: 'smooth' });
      return emitRenderedRowSelection(scroller, target);
    }
    var maxScroll = Math.max(0, (Number(scroller.scrollHeight) || 0) - viewportHeight(scroller));
    var scrollTop = Number(scroller.scrollTop) || 0;
    var nextScrollTop = Math.max(0, Math.min(maxScroll, scrollTop + direction * rowStep(rows, current)));
    if (nextScrollTop === scrollTop) { return false; }
    resetSmoothTarget(scroller);
    pendingRenderedRowMoves.set(scroller, {
      attempts: 0,
      direction: direction,
      from: rowValue(rows[current])
    });
    scroller.scrollTo({ top: nextScrollTop, behavior: 'smooth' });
    schedulePendingRenderedRowResolution(scroller);
    return { pending: true };
  }

  function runMotion(scroller, kind, direction) {
    if (!scroller) { return; }
    var maxScroll = Math.max(0, (Number(scroller.scrollHeight) || 0) - viewportHeight(scroller));
    if (kind === 'edge') {
      var edgeTarget = direction > 0 ? maxScroll : 0;
      smoothTargets.set(scroller, { target: edgeTarget, time: Date.now() });
      scroller.scrollTo({ top: edgeTarget, behavior: 'smooth' });
      return;
    }
    var amount = kind === 'halfPage'
      ? Math.max(80, Math.floor(viewportHeight(scroller) * 0.5))
      : 72;
    var now = Date.now();
    var previous = smoothTargets.get(scroller);
    var current = Number(scroller.scrollTop) || 0;
    var base = previous && now - previous.time < 300 ? previous.target : current;
    var target = Math.max(0, Math.min(maxScroll, base + direction * amount));
    smoothTargets.set(scroller, { target: target, time: now });
    scroller.scrollTo({ top: target, behavior: 'smooth' });
  }

  function installManualInputReset(options) {
    var target = options && options.target;
    var getScroller = options && options.getScroller;
    if (!target || typeof target.addEventListener !== 'function' || typeof getScroller !== 'function') {
      return function() {};
    }

    function clearSmoothTarget() {
      resetSmoothTarget(getScroller());
    }

    function clearForNativeScrollKey(event) {
      if (isNativeScrollKey(event)) { clearSmoothTarget(); }
    }

    target.addEventListener('keydown', clearForNativeScrollKey, true);
    target.addEventListener('wheel', clearSmoothTarget, true);
    target.addEventListener('touchstart', clearSmoothTarget, true);
    target.addEventListener('pointerdown', clearSmoothTarget, true);
    return function() {
      target.removeEventListener('keydown', clearForNativeScrollKey, true);
      target.removeEventListener('wheel', clearSmoothTarget, true);
      target.removeEventListener('touchstart', clearSmoothTarget, true);
      target.removeEventListener('pointerdown', clearSmoothTarget, true);
    };
  }

  function install(options) {
    var target = options && options.target;
    var getScroller = options && options.getScroller;
    var shortcuts = (options && options.shortcuts) || {};
    if (!target || typeof target.addEventListener !== 'function' || typeof getScroller !== 'function') {
      return function() {};
    }

    var bindings = actionMotions.map(function(entry) {
      return {
        action: entry[0],
        shortcut: normalizeShortcut(shortcuts[entry[0]]),
        kind: entry[1],
        direction: entry[2]
      };
    }).filter(function(entry) { return entry.shortcut; });
    var pending = null;
    var pendingTimer = 0;
    var disposeManualInputReset = installManualInputReset({ target: target, getScroller: getScroller });

    function clearPending() {
      pending = null;
      if (pendingTimer) {
        global.clearTimeout(pendingTimer);
        pendingTimer = 0;
      }
    }

    function listener(event) {
      if (event.defaultPrevented || isEditableTarget(event.target)) { return; }
      if (pending) {
        if (strokeMatches(pending.shortcut.second, event)) {
          event.preventDefault();
          performAction(pending.action, getScroller());
          clearPending();
          return;
        }
        clearPending();
      }
      for (var i = 0; i < bindings.length; i++) {
        var binding = bindings[i];
        if (!strokeMatches(binding.shortcut.first, event)) { continue; }
        event.preventDefault();
        if (binding.shortcut.second) {
          pending = binding;
          pendingTimer = global.setTimeout(clearPending, 700);
        } else {
          performAction(binding.action, getScroller());
        }
        return;
      }
    }

    target.addEventListener('keydown', listener);
    return function() {
      clearPending();
      target.removeEventListener('keydown', listener);
      disposeManualInputReset();
    };
  }

  global.CmuxViewerNavigation = {
    install: install,
    installManualInputReset: installManualInputReset,
    hasPendingRenderedRowMove: function(scroller) { return Boolean(scroller && pendingRenderedRowMoves.has(scroller)); },
    moveRenderedRow: moveRenderedRow,
    performAction: performAction,
    refreshRenderedRows: refreshRenderedRows,
    resetSmoothTarget: resetSmoothTarget
  };
})(globalThis);
