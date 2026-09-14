figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER
   STRICT VISUAL PROTECTION VERSION
   =========================================================

   제1법칙
   ---------------------------------------------------------
   디자인 화면은 절대 변경하지 않는다.

   핵심 방식
   ---------------------------------------------------------
   ORIGINAL
      ↓ clone
   WORKING COPY
      ↓
   Garbage / Detach / Flatten / Ordering 시도
      ↓
   매 작업마다 PNG 비교
      ↓
   SAME   → 유지
   CHANGE → 해당 작업만 Rollback
      ↓
   최종 ORIGINAL vs WORKING PNG 비교
      ↓
   SAME   → 결과 Commit
   CHANGE → Working Copy 삭제 / Original 유지

   기존 기능
   ---------------------------------------------------------
   ✓ Garbage Review & Delete
   ✓ 체크한 Garbage만 삭제
   ✓ Hidden Instance도 삭제 시도
   ✓ Instance Detach
   ✓ 안전한 Frame / Group Flatten
   ✓ LID 이름 보호
   ✓ 일반 Text 이름 "-" 옵션
   ✓ Inter 옵션
   ✓ icon / line / shape / image / screenshot
   ✓ frame / group / instance / component
   ✓ 위→아래 / 같은 줄 좌→우 정렬
========================================================= */


/* =========================================================
   GLOBAL
========================================================= */

let renameTextToHyphen = false;
let convertFontToInter = false;

let approvedGarbageIds = new Set();

const WORK_OFFSET = 20000;
const CHECKPOINT_OFFSET = 30000;
const MAX_INSTANCE_PASSES = 10;
const MAX_FLATTEN_PASSES = 30;

const ROW_TOLERANCE = 8;


/* =========================================================
   STATS
========================================================= */

function createStats() {
  return {
    detachedInstances: 0,

    removedGarbage: 0,
    protectedGarbage: 0,

    removedContainers: 0,
    movedLayers: 0,

    preservedAreas: 0,

    convertedTexts: 0,
    convertedFontSegments: 0,
    failedFontConversions: 0,

    visualShells: 0,
    bakedAreas: 0,

    visualRejected: 0,

    finalLayers: 0
  };
}


/* =========================================================
   SAFE HELPERS
========================================================= */

function safeType(node) {
  try {
    return node ? node.type : null;
  } catch (_) {
    return null;
  }
}


function safeName(node) {
  try {
    return node ? node.name : "";
  } catch (_) {
    return "";
  }
}


function safeId(node) {
  try {
    return node ? node.id : null;
  } catch (_) {
    return null;
  }
}


function safeParent(node) {
  try {
    return node ? node.parent : null;
  } catch (_) {
    return null;
  }
}


function isAlive(node) {
  if (!node) {
    return false;
  }

  try {
    return !!node.parent;
  } catch (_) {
    return false;
  }
}


function childrenOf(node) {
  if (!isAlive(node)) {
    return [];
  }

  try {
    if (!("children" in node)) {
      return [];
    }

    return [...node.children];
  } catch (_) {
    return [];
  }
}


function safeBounds(node) {
  try {
    return node.absoluteBoundingBox || null;
  } catch (_) {
    return null;
  }
}


function safeRenderBounds(node) {
  try {
    return (
      node.absoluteRenderBounds ||
      node.absoluteBoundingBox ||
      null
    );
  } catch (_) {
    return null;
  }
}


function safeTransform(node) {
  try {
    return node.absoluteTransform;
  } catch (_) {
    return null;
  }
}


function safeRemove(node) {
  if (!isAlive(node)) {
    return false;
  }

  try {
    node.remove();
    return true;
  } catch (error) {
    console.warn(
      "Remove failed:",
      safeName(node),
      error
    );

    return false;
  }
}


/* =========================================================
   TYPES
========================================================= */

function isContainer(node) {
  const type = safeType(node);

  return (
    type === "FRAME" ||
    type === "GROUP" ||
    type === "COMPONENT" ||
    type === "INSTANCE"
  );
}


function isSupportedRoot(node) {
  return isContainer(node);
}


function isAutoLayout(node) {
  try {
    return (
      "layoutMode" in node &&
      node.layoutMode !== "NONE"
    );
  } catch (_) {
    return false;
  }
}


/* =========================================================
   TRANSFORM
========================================================= */

function multiplyTransform(a, b) {
  return [
    [
      a[0][0] * b[0][0] +
        a[0][1] * b[1][0],

      a[0][0] * b[0][1] +
        a[0][1] * b[1][1],

      a[0][0] * b[0][2] +
        a[0][1] * b[1][2] +
        a[0][2]
    ],

    [
      a[1][0] * b[0][0] +
        a[1][1] * b[1][0],

      a[1][0] * b[0][1] +
        a[1][1] * b[1][1],

      a[1][0] * b[0][2] +
        a[1][1] * b[1][2] +
        a[1][2]
    ]
  ];
}


function invertTransform(m) {
  const a = m[0][0];
  const c = m[0][1];
  const e = m[0][2];

  const b = m[1][0];
  const d = m[1][1];
  const f = m[1][2];

  const det =
    a * d -
    b * c;

  if (
    Math.abs(det) <
    0.000001
  ) {
    throw new Error(
      "Transform cannot be inverted."
    );
  }

  const inv =
    1 / det;

  return [
    [
      d * inv,
      -c * inv,
      (c * f - d * e) * inv
    ],

    [
      -b * inv,
      a * inv,
      (b * e - a * f) * inv
    ]
  ];
}


function absoluteToRelative(
  absoluteTransform,
  parent
) {
  const parentTransform =
    safeTransform(parent);

  if (!parentTransform) {
    throw new Error(
      "Parent transform unavailable."
    );
  }

  return multiplyTransform(
    invertTransform(
      parentTransform
    ),
    absoluteTransform
  );
}


/* =========================================================
   PATH
   ---------------------------------------------------------
   Original ID → structural path → Working Copy node
========================================================= */

function createPathMap(root) {
  const map =
    new Map();


  function walk(
    node,
    path
  ) {
    if (!isAlive(node)) {
      return;
    }

    const id =
      safeId(node);

    if (id) {
      map.set(
        id,
        [...path]
      );
    }


    const children =
      childrenOf(node);


    for (
      let i = 0;
      i < children.length;
      i++
    ) {
      walk(
        children[i],
        [...path, i]
      );
    }
  }


  walk(
    root,
    []
  );


  return map;
}


function resolvePath(
  root,
  path
) {
  let current =
    root;


  for (
    const index of path
  ) {
    const children =
      childrenOf(current);


    if (
      index < 0 ||
      index >= children.length
    ) {
      return null;
    }


    current =
      children[index];


    if (!isAlive(current)) {
      return null;
    }
  }


  return current;
}


function getPathFromRoot(
  root,
  node
) {
  const reversed =
    [];

  let current =
    node;


  while (
    current &&
    current !== root
  ) {
    const parent =
      safeParent(current);


    if (!parent) {
      return null;
    }


    const children =
      childrenOf(parent);


    const index =
      children.indexOf(
        current
      );


    if (
      index < 0
    ) {
      return null;
    }


    reversed.push(index);

    current =
      parent;
  }


  if (
    current !== root
  ) {
    return null;
  }


  return reversed.reverse();
}


/* =========================================================
   PNG VISUAL COMPARISON
========================================================= */

async function exportNodePng(node) {
  if (!isAlive(node)) {
    return null;
  }


  try {
    return await node.exportAsync({
      format:
        "PNG",

      constraint: {
        type:
          "SCALE",

        value:
          1
      }
    });

  } catch (error) {
    console.warn(
      "PNG export failed:",
      safeName(node),
      error
    );

    return null;
  }
}


function sameBytes(a, b) {
  if (
    !a ||
    !b
  ) {
    return false;
  }


  if (
    a.length !==
    b.length
  ) {
    return false;
  }


  for (
    let i = 0;
    i < a.length;
    i++
  ) {
    if (
      a[i] !== b[i]
    ) {
      return false;
    }
  }


  return true;
}


/* =========================================================
   TRANSACTION
   ---------------------------------------------------------
   모든 구조 변경은 Working Copy에서만 수행.

   변경 전:
   - Working Root 전체 Checkpoint 생성
   - PNG 저장

   변경 후:
   - PNG 동일 → 변경 유지
   - PNG 다름 → Working Root 폐기
                Checkpoint 복원
========================================================= */

async function visualTransaction(
  workRoot,
  mutate
) {
  if (!isAlive(workRoot)) {
    return {
      root:
        workRoot,

      accepted:
        false,

      changed:
        false
    };
  }


  const before =
    await exportNodePng(
      workRoot
    );


  if (!before) {
    return {
      root:
        workRoot,

      accepted:
        false,

      changed:
        false
    };
  }


  const page =
    figma.currentPage;


  const workX =
    workRoot.x;

  const workY =
    workRoot.y;


  let checkpoint = null;


  try {
    checkpoint =
      workRoot.clone();


    page.appendChild(
      checkpoint
    );


    checkpoint.x =
      workX +
      CHECKPOINT_OFFSET;

    checkpoint.y =
      workY;

  } catch (error) {
    console.warn(
      "Checkpoint creation failed:",
      error
    );


    if (
      checkpoint &&
      isAlive(checkpoint)
    ) {
      checkpoint.remove();
    }


    return {
      root:
        workRoot,

      accepted:
        false,

      changed:
        false
    };
  }


  let mutationResult = null;


  try {
    mutationResult =
      await mutate(
        workRoot
      );

  } catch (error) {
    console.warn(
      "Mutation failed:",
      error
    );


    if (
      isAlive(workRoot)
    ) {
      workRoot.remove();
    }


    checkpoint.x =
      workX;

    checkpoint.y =
      workY;


    return {
      root:
        checkpoint,

      accepted:
        false,

      changed:
        false
    };
  }


  /*
   * Mutation 함수가
   * Root 자체를 교체할 수 있음.
   */
  let changedRoot =
    (
      mutationResult &&
      mutationResult.root &&
      isAlive(
        mutationResult.root
      )
    )
      ? mutationResult.root
      : workRoot;


  const changed =
    !!(
      mutationResult &&
      mutationResult.changed
    );


  /*
   * 실제 변경이 없었다면 Checkpoint 삭제.
   */
  if (!changed) {
    safeRemove(
      checkpoint
    );


    return {
      root:
        changedRoot,

      accepted:
        false,

      changed:
        false,

      data:
        mutationResult
    };
  }


  const after =
    await exportNodePng(
      changedRoot
    );


  if (
    after &&
    sameBytes(
      before,
      after
    )
  ) {
    /*
     * Visual 동일.
     */
    safeRemove(
      checkpoint
    );


    return {
      root:
        changedRoot,

      accepted:
        true,

      changed:
        true,

      data:
        mutationResult
    };
  }


  /*
   * Visual 변경.
   *
   * 변경된 Working Root 버리고
   * Checkpoint 복원.
   */
  safeRemove(
    changedRoot
  );


  checkpoint.x =
    workX;

  checkpoint.y =
    workY;


  return {
    root:
      checkpoint,

    accepted:
      false,

    changed:
      true,

    data:
      mutationResult
  };
}


/* =========================================================
   LID
========================================================= */

function isLidName(name) {
  if (!name) {
    return false;
  }


  const value =
    String(name)
      .trim()
      .toLowerCase();


  return (
    value.startsWith(
      "cci_ctn_"
    ) ||

    value.startsWith(
      "cci_msg_"
    ) ||

    value.startsWith(
      "ctn_"
    ) ||

    value.startsWith(
      "msg_"
    )
  );
}


/* =========================================================
   GARBAGE
========================================================= */

function getGarbageReason(node) {
  if (!isAlive(node)) {
    return null;
  }


  try {
    if (
      "visible" in node &&
      node.visible === false
    ) {
      return (
        "Hidden · visible=false"
      );
    }
  } catch (_) {}


  try {
    if (
      "opacity" in node &&
      node.opacity === 0
    ) {
      return (
        "Transparent · opacity=0"
      );
    }
  } catch (_) {}


  if (
    safeType(node) ===
    "SLICE"
  ) {
    return "Slice Layer";
  }


  if (
    isContainer(node)
  ) {
    const bounds =
      safeRenderBounds(node);


    if (
      !bounds ||
      bounds.width <= 0.01 ||
      bounds.height <= 0.01
    ) {
      return (
        "No Rendered Content"
      );
    }
  }


  return null;
}


/*
 * Analyze할 때는 Original ID를 보낸다.
 */
function collectGarbageItems(root) {
  const result =
    [];


  function walk(
    node,
    displayPath
  ) {
    if (!isAlive(node)) {
      return;
    }


    const name =
      safeName(node);


    const path =
      displayPath
        ? `${displayPath} / ${name}`
        : name;


    const reason =
      getGarbageReason(node);


    if (reason) {
      result.push({
        id:
          safeId(node) || "",

        name,

        type:
          safeType(node) ||
          "UNKNOWN",

        reason,

        path
      });
    }


    for (
      const child of
      childrenOf(node)
    ) {
      walk(
        child,
        path
      );
    }
  }


  walk(
    root,
    ""
  );


  return result;
}


/* =========================================================
   FONTS
========================================================= */

const loadedFonts =
  new Set();


async function loadFontOnce(
  fontName
) {
  if (
    !fontName ||
    fontName ===
      figma.mixed
  ) {
    return false;
  }


  const key =
    `${fontName.family}::${fontName.style}`;


  if (
    loadedFonts.has(key)
  ) {
    return true;
  }


  try {
    await figma.loadFontAsync({
      family:
        fontName.family,

      style:
        fontName.style
    });


    loadedFonts.add(
      key
    );


    return true;

  } catch (error) {
    console.warn(
      "Font load failed:",
      key
    );


    return false;
  }
}


async function ensureTextFontsLoaded(
  node
) {
  if (
    safeType(node) !==
    "TEXT"
  ) {
    return true;
  }


  try {
    const segments =
      node.getStyledTextSegments(
        ["fontName"]
      );


    for (
      const segment of segments
    ) {
      if (
        !segment.fontName ||
        segment.fontName ===
          figma.mixed
      ) {
        continue;
      }


      if (
        !await loadFontOnce(
          segment.fontName
        )
      ) {
        return false;
      }
    }


    return true;

  } catch (_) {}


  try {
    if (
      node.fontName !==
      figma.mixed
    ) {
      return await loadFontOnce(
        node.fontName
      );
    }
  } catch (_) {}


  return false;
}


async function ensureSubtreeFontsLoaded(
  node
) {
  if (!isAlive(node)) {
    return false;
  }


  if (
    safeType(node) ===
    "TEXT"
  ) {
    return await ensureTextFontsLoaded(
      node
    );
  }


  for (
    const child of
    childrenOf(node)
  ) {
    if (
      !await ensureSubtreeFontsLoaded(
        child
      )
    ) {
      return false;
    }
  }


  return true;
}


/* =========================================================
   INTER
========================================================= */

const loadedInterStyles =
  new Set();


function mapInterStyle(style) {
  const value =
    String(style || "")
      .toLowerCase()
      .replace(
        /[_-]/g,
        " "
      );


  const italic =
    value.includes(
      "italic"
    ) ||
    value.includes(
      "oblique"
    );


  let weight =
    "Regular";


  if (
    value.includes("black") ||
    value.includes("heavy")
  ) {
    weight =
      "Black";

  } else if (
    value.includes(
      "extra bold"
    ) ||
    value.includes(
      "extrabold"
    )
  ) {
    weight =
      "Extra Bold";

  } else if (
    value.includes(
      "semi bold"
    ) ||
    value.includes(
      "semibold"
    )
  ) {
    weight =
      "Semi Bold";

  } else if (
    value.includes("bold")
  ) {
    weight =
      "Bold";

  } else if (
    value.includes("medium")
  ) {
    weight =
      "Medium";

  } else if (
    value.includes(
      "extra light"
    ) ||
    value.includes(
      "extralight"
    )
  ) {
    weight =
      "Extra Light";

  } else if (
    value.includes("light")
  ) {
    weight =
      "Light";

  } else if (
    value.includes("thin")
  ) {
    weight =
      "Thin";
  }


  if (italic) {
    return (
      weight === "Regular"
        ? "Italic"
        : `${weight} Italic`
    );
  }


  return weight;
}


async function loadInterStyle(
  style
) {
  if (
    loadedInterStyles.has(
      style
    )
  ) {
    return style;
  }


  try {
    await figma.loadFontAsync({
      family:
        "Inter",

      style
    });


    loadedInterStyles.add(
      style
    );


    return style;

  } catch (_) {}


  try {
    await figma.loadFontAsync({
      family:
        "Inter",

      style:
        "Regular"
    });


    loadedInterStyles.add(
      "Regular"
    );


    return "Regular";

  } catch (_) {
    return null;
  }
}


async function convertTextToInter(
  node
) {
  if (
    safeType(node) !==
    "TEXT"
  ) {
    return 0;
  }


  if (
    !await ensureTextFontsLoaded(
      node
    )
  ) {
    return 0;
  }


  try {
    const segments =
      node.getStyledTextSegments(
        ["fontName"]
      );


    let converted = 0;


    for (
      const segment of segments
    ) {
      const oldStyle =
        (
          segment.fontName &&
          segment.fontName !==
            figma.mixed
        )
          ? segment.fontName.style
          : "Regular";


      const newStyle =
        await loadInterStyle(
          mapInterStyle(
            oldStyle
          )
        );


      if (!newStyle) {
        continue;
      }


      node.setRangeFontName(
        segment.start,
        segment.end,
        {
          family:
            "Inter",

          style:
            newStyle
        }
      );


      converted++;
    }


    return converted;

  } catch (_) {
    return 0;
  }
}


/* =========================================================
   NAMING
========================================================= */

function hasImageFill(node) {
  try {
    if (
      !("fills" in node) ||
      node.fills ===
        figma.mixed ||
      !Array.isArray(
        node.fills
      )
    ) {
      return false;
    }


    return node.fills.some(
      fill =>
        fill.type === "IMAGE" &&
        fill.visible !== false
    );

  } catch (_) {
    return false;
  }
}


function looksLikeIcon(node) {
  const type =
    safeType(node);


  const name =
    safeName(node)
      .toLowerCase();


  if (
    type === "VECTOR" ||
    type ===
      "BOOLEAN_OPERATION" ||
    type === "POLYGON" ||
    type === "STAR"
  ) {
    return true;
  }


  if (
    type === "ELLIPSE"
  ) {
    return (
      name.includes(
        "icon"
      ) ||
      name.includes(
        "ic_"
      ) ||
      name.startsWith(
        "ic/"
      )
    );
  }


  return false;
}


function looksLikeScreenshot(
  node,
  root
) {
  if (
    safeType(node) !==
      "RECTANGLE" ||
    !hasImageFill(node)
  ) {
    return false;
  }


  const value =
    safeName(node)
      .toLowerCase();


  if (
    value.includes(
      "screenshot"
    ) ||
    value.includes(
      "screen shot"
    ) ||
    value.includes(
      "스크린샷"
    )
  ) {
    return true;
  }


  try {
    return (
      root.width > 0 &&
      root.height > 0 &&
      node.width /
        root.width >=
        0.7 &&
      node.height /
        root.height >=
        0.5
    );

  } catch (_) {
    return false;
  }
}


function looksLikeIPhone(node) {
  const value =
    safeName(node)
      .toLowerCase();


  return (
    value.includes(
      "iphone"
    ) ||
    value.includes(
      "i phone"
    )
  );
}


function normalizeLayerName(
  node,
  root
) {
  if (!isAlive(node)) {
    return;
  }


  const type =
    safeType(node);


  const currentName =
    safeName(node);


  /*
   * TEXT
   */
  if (
    type === "TEXT"
  ) {
    /*
     * LID는 이름 유지.
     */
    if (
      isLidName(
        currentName
      )
    ) {
      return;
    }


    if (
      renameTextToHyphen
    ) {
      try {
        node.name =
          "-";
      } catch (_) {}
    }


    return;
  }


  /*
   * LINE
   */
  if (
    type === "LINE"
  ) {
    try {
      node.name =
        "line";
    } catch (_) {}

    return;
  }


  /*
   * ICON
   */
  if (
    looksLikeIcon(node)
  ) {
    try {
      node.name =
        "icon";
    } catch (_) {}

    return;
  }


  /*
   * RECTANGLE
   */
  if (
    type === "RECTANGLE"
  ) {
    try {
      if (
        hasImageFill(node)
      ) {
        node.name =
          looksLikeScreenshot(
            node,
            root
          )
            ? "screenshot"
            : "image";

      } else {
        node.name =
          "shape";
      }

    } catch (_) {}

    return;
  }


  /*
   * ELLIPSE
   */
  if (
    type === "ELLIPSE"
  ) {
    try {
      node.name =
        "shape";
    } catch (_) {}

    return;
  }


  /*
   * GROUP
   */
  if (
    type === "GROUP"
  ) {
    try {
      node.name =
        "group";
    } catch (_) {}

    return;
  }


  /*
   * FRAME
   */
  if (
    type === "FRAME"
  ) {
    try {
      node.name =
        looksLikeIPhone(node)
          ? "iphone"
          : "frame";
    } catch (_) {}

    return;
  }


  /*
   * COMPONENT
   */
  if (
    type === "COMPONENT"
  ) {
    try {
      node.name =
        "component";
    } catch (_) {}

    return;
  }


  /*
   * INSTANCE
   */
  if (
    type === "INSTANCE"
  ) {
    try {
      node.name =
        "instance";
    } catch (_) {}
  }
}


async function normalizeNamesRecursive(
  node,
  root
) {
  if (!isAlive(node)) {
    return;
  }


  normalizeLayerName(
    node,
    root
  );


  for (
    const child of
    childrenOf(node)
  ) {
    await normalizeNamesRecursive(
      child,
      root
    );
  }
}


/* =========================================================
   VISUAL SHELL
   ---------------------------------------------------------
   Frame의 자체 Fill / Stroke가 있으면
   Flatten 시 shape로 복원 시도.
   최종적으로 PNG가 달라지면 자동 Rollback.
========================================================= */

function hasVisiblePaint(paints) {
  if (
    !Array.isArray(paints)
  ) {
    return false;
  }


  return paints.some(
    paint => {
      if (
        paint.visible === false
      ) {
        return false;
      }


      if (
        typeof paint.opacity ===
          "number" &&
        paint.opacity === 0
      ) {
        return false;
      }


      return true;
    }
  );
}


function hasOwnVisual(node) {
  try {
    if (
      "fills" in node &&
      node.fills !==
        figma.mixed &&
      hasVisiblePaint(
        node.fills
      )
    ) {
      return true;
    }
  } catch (_) {}


  try {
    if (
      "strokes" in node &&
      node.strokes !==
        figma.mixed &&
      hasVisiblePaint(
        node.strokes
      )
    ) {
      return true;
    }
  } catch (_) {}


  return false;
}


function createVisualShell(
  source,
  parent,
  insertIndex
) {
  if (
    !isAlive(source) ||
    !isAlive(parent)
  ) {
    return null;
  }


  const transform =
    safeTransform(source);


  if (!transform) {
    return null;
  }


  const rect =
    figma.createRectangle();


  rect.name =
    "shape";


  try {
    rect.resize(
      Math.max(
        source.width,
        0.01
      ),

      Math.max(
        source.height,
        0.01
      )
    );
  } catch (_) {
    safeRemove(rect);
    return null;
  }


  try {
    if (
      source.fills !==
      figma.mixed
    ) {
      rect.fills =
        source.fills;
    }
  } catch (_) {}


  try {
    if (
      source.strokes !==
      figma.mixed
    ) {
      rect.strokes =
        source.strokes;
    }
  } catch (_) {}


  try {
    rect.strokeWeight =
      source.strokeWeight;
  } catch (_) {}


  try {
    rect.strokeAlign =
      source.strokeAlign;
  } catch (_) {}


  try {
    rect.effects =
      source.effects;
  } catch (_) {}


  try {
    rect.opacity =
      source.opacity;
  } catch (_) {}


  try {
    rect.blendMode =
      source.blendMode;
  } catch (_) {}


  try {
    rect.topLeftRadius =
      source.topLeftRadius;

    rect.topRightRadius =
      source.topRightRadius;

    rect.bottomLeftRadius =
      source.bottomLeftRadius;

    rect.bottomRightRadius =
      source.bottomRightRadius;
  } catch (_) {}


  try {
    parent.insertChild(
      insertIndex,
      rect
    );


    rect.relativeTransform =
      absoluteToRelative(
        transform,
        parent
      );


    return rect;

  } catch (_) {
    safeRemove(rect);

    return null;
  }
}


/* =========================================================
   INSTANCE
========================================================= */

function getInstancePaths(root) {
  const result =
    [];


  function walk(
    node,
    path
  ) {
    for (
      let i = 0;
      i <
        childrenOf(node).length;
      i++
    ) {
      const child =
        childrenOf(node)[i];

      const childPath =
        [...path, i];


      if (
        safeType(child) ===
        "INSTANCE"
      ) {
        result.push(
          childPath
        );
      }


      walk(
        child,
        childPath
      );
    }
  }


  walk(
    root,
    []
  );


  /*
   * 깊은 Instance부터.
   */
  result.sort(
    (a, b) =>
      b.length -
      a.length
  );


  return result;
}


async function attemptDetachInstance(
  workRoot,
  path
) {
  const node =
    resolvePath(
      workRoot,
      path
    );


  if (
    !node ||
    safeType(node) !==
      "INSTANCE"
  ) {
    return {
      root:
        workRoot,

      changed:
        false
    };
  }


  try {
    const detached =
      node.detachInstance();


    return {
      root:
        workRoot,

      changed:
        !!detached
    };

  } catch (_) {
    return {
      root:
        workRoot,

      changed:
        false
    };
  }
}


/* =========================================================
   FLATTEN CANDIDATES
========================================================= */

function containsMask(node) {
  for (
    const child of
    childrenOf(node)
  ) {
    try {
      if (
        "isMask" in child &&
        child.isMask === true
      ) {
        return true;
      }
    } catch (_) {}


    if (
      containsMask(child)
    ) {
      return true;
    }
  }


  return false;
}


/*
 * Mask는 실제 구조 의미가 강하므로
 * 아예 Flatten 시도하지 않는다.
 *
 * 나머지는 Clone에서 시도 후
 * PNG 검증으로 판단.
 */
function canAttemptFlatten(node) {
  if (!isAlive(node)) {
    return false;
  }


  const type =
    safeType(node);


  if (
    type !== "FRAME" &&
    type !== "GROUP" &&
    type !== "COMPONENT"
  ) {
    return false;
  }


  if (
    containsMask(node)
  ) {
    return false;
  }


  return true;
}


function collectFlattenPaths(root) {
  const result =
    [];


  function walk(
    node,
    path
  ) {
    const children =
      childrenOf(node);


    for (
      let i = 0;
      i < children.length;
      i++
    ) {
      const child =
        children[i];

      const childPath =
        [...path, i];


      walk(
        child,
        childPath
      );


      if (
        canAttemptFlatten(
          child
        )
      ) {
        result.push(
          childPath
        );
      }
    }
  }


  walk(
    root,
    []
  );


  /*
   * 가장 깊은 Frame부터.
   */
  result.sort(
    (a, b) =>
      b.length -
      a.length
  );


  return result;
}


/* =========================================================
   ONE LEVEL FLATTEN
========================================================= */

async function flattenOneLevel(
  workRoot,
  path
) {
  const container =
    resolvePath(
      workRoot,
      path
    );


  if (
    !container ||
    !canAttemptFlatten(
      container
    )
  ) {
    return {
      root:
        workRoot,

      changed:
        false,

      moved:
        0,

      removed:
        0,

      shells:
        0
    };
  }


  const parent =
    safeParent(
      container
    );


  if (
    !parent ||
    !("children" in parent)
  ) {
    return {
      root:
        workRoot,

      changed:
        false,

      moved:
        0,

      removed:
        0,

      shells:
        0
    };
  }


  /*
   * Root 자체는 제거하지 않는다.
   */
  if (
    container ===
    workRoot
  ) {
    return {
      root:
        workRoot,

      changed:
        false,

      moved:
        0,

      removed:
        0,

      shells:
        0
    };
  }


  let index = -1;


  try {
    index =
      parent.children.indexOf(
        container
      );
  } catch (_) {}


  if (
    index < 0
  ) {
    return {
      root:
        workRoot,

      changed:
        false,

      moved:
        0,

      removed:
        0,

      shells:
        0
    };
  }


  const children =
    childrenOf(
      container
    );


  /*
   * 폰트 미로딩 때문에 append/insert가
   * 실패하는 문제 예방.
   */
  for (
    const child of children
  ) {
    if (
      !await ensureSubtreeFontsLoaded(
        child
      )
    ) {
      return {
        root:
          workRoot,

        changed:
          false,

        moved:
          0,

        removed:
          0,

        shells:
          0
      };
    }
  }


  const snapshots =
    children.map(
      child => ({
        node:
          child,

        transform:
          safeTransform(
            child
          )
      })
    );


  if (
    snapshots.some(
      item =>
        !item.transform
    )
  ) {
    return {
      root:
        workRoot,

      changed:
        false,

      moved:
        0,

      removed:
        0,

      shells:
        0
    };
  }


  let insertionIndex =
    index;

  let shells =
    0;


  /*
   * Container 자체 Fill / Stroke가 있다면
   * visual shell을 먼저 삽입.
   */
  if (
    hasOwnVisual(
      container
    )
  ) {
    const shell =
      createVisualShell(
        container,
        parent,
        insertionIndex
      );


    if (shell) {
      insertionIndex++;
      shells++;
    }
  }


  let moved =
    0;


  for (
    const item of snapshots
  ) {
    const child =
      item.node;


    /*
     * Parent가 Auto Layout이면
     * 가능할 경우 Absolute positioning으로 전환.
     * 결과가 조금이라도 달라지면 Transaction이 Rollback.
     */
    try {
      if (
        isAutoLayout(
          parent
        ) &&
        "layoutPositioning" in child
      ) {
        child.layoutPositioning =
          "ABSOLUTE";
      }
    } catch (_) {}


    parent.insertChild(
      insertionIndex,
      child
    );


    child.relativeTransform =
      absoluteToRelative(
        item.transform,
        parent
      );


    insertionIndex++;
    moved++;
  }


  if (
    childrenOf(container)
      .length !== 0
  ) {
    return {
      root:
        workRoot,

      changed:
        false,

      moved:
        0,

      removed:
        0,

      shells:
        0
    };
  }


  safeRemove(
    container
  );


  return {
    root:
      workRoot,

    changed:
      true,

    moved,

    removed:
      1,

    shells
  };
}


/* =========================================================
   GARBAGE DELETE
========================================================= */

async function deleteGarbageNode(
  workRoot,
  node
) {
  if (
    !node ||
    !isAlive(node)
  ) {
    return {
      root:
        workRoot,

      changed:
        false
    };
  }


  if (
    !getGarbageReason(
      node
    )
  ) {
    return {
      root:
        workRoot,

      changed:
        false
    };
  }


  if (
    safeRemove(node)
  ) {
    return {
      root:
        workRoot,

      changed:
        true
    };
  }


  return {
    root:
      workRoot,

    changed:
      false
  };
}


/* =========================================================
   SPATIAL ORDER
========================================================= */

function spatialBounds(node) {
  const b =
    safeBounds(node);


  if (!b) {
    return null;
  }


  return {
    x:
      b.x,

    y:
      b.y,

    width:
      b.width,

    height:
      b.height
  };
}


function compareSpatial(
  a,
  b
) {
  if (
    !a.bounds ||
    !b.bounds
  ) {
    return (
      a.oldPanelIndex -
      b.oldPanelIndex
    );
  }


  const ay =
    a.bounds.y +
    a.bounds.height / 2;


  const by =
    b.bounds.y +
    b.bounds.height / 2;


  /*
   * 같은 줄 → 왼쪽에서 오른쪽.
   */
  if (
    Math.abs(
      ay - by
    ) <= ROW_TOLERANCE
  ) {
    const dx =
      a.bounds.x -
      b.bounds.x;


    if (
      Math.abs(dx) >
      0.1
    ) {
      return dx;
    }
  }


  /*
   * 다른 줄 → 위에서 아래.
   */
  const dy =
    a.bounds.y -
    b.bounds.y;


  if (
    Math.abs(dy) >
    0.1
  ) {
    return dy;
  }


  return (
    a.oldPanelIndex -
    b.oldPanelIndex
  );
}


async function attemptSpatialOrder(
  workRoot
) {
  /*
   * Root Auto Layout의 children 순서를 바꾸면
   * 실제 화면 위치가 거의 반드시 바뀐다.
   *
   * 시도 자체를 하지 않는다.
   */
  if (
    isAutoLayout(
      workRoot
    )
  ) {
    return {
      root:
        workRoot,

      changed:
        false
    };
  }


  const children =
    childrenOf(
      workRoot
    );


  if (
    children.length <= 1
  ) {
    return {
      root:
        workRoot,

      changed:
        false
    };
  }


  /*
   * Figma Layer Panel은
   * children의 reverse.
   */
  const panel =
    [...children]
      .reverse();


  const items =
    panel.map(
      (node, index) => ({
        node,

        bounds:
          spatialBounds(
            node
          ),

        oldPanelIndex:
          index
      })
    );


  items.sort(
    compareSpatial
  );


  const desiredChildren =
    items
      .map(
        item =>
          item.node
      )
      .reverse();


  /*
   * 이미 같은 순서인지 확인.
   */
  let changed =
    false;


  for (
    let i = 0;
    i < children.length;
    i++
  ) {
    if (
      children[i] !==
      desiredChildren[i]
    ) {
      changed =
        true;

      break;
    }
  }


  if (!changed) {
    return {
      root:
        workRoot,

      changed:
        false
    };
  }


  for (
    let i = 0;
    i < desiredChildren.length;
    i++
  ) {
    workRoot.insertChild(
      i,
      desiredChildren[i]
    );
  }


  return {
    root:
      workRoot,

    changed:
      true
  };
}


/* =========================================================
   INTER WITH VISUAL GUARD
========================================================= */

function collectTextPaths(root) {
  const result =
    [];


  function walk(
    node,
    path
  ) {
    const children =
      childrenOf(node);


    for (
      let i = 0;
      i < children.length;
      i++
    ) {
      const child =
        children[i];

      const p =
        [...path, i];


      if (
        safeType(child) ===
        "TEXT"
      ) {
        result.push(p);
      }


      walk(
        child,
        p
      );
    }
  }


  if (
    safeType(root) ===
    "TEXT"
  ) {
    result.push([]);
  }


  walk(
    root,
    []
  );


  return result;
}


/* =========================================================
   COUNT
========================================================= */

function countLayers(root) {
  let count =
    0;


  function walk(node) {
    for (
      const child of
      childrenOf(node)
    ) {
      count++;

      walk(child);
    }
  }


  walk(root);

  return count;
}


function countContainers(root) {
  let count =
    0;


  function walk(node) {
    for (
      const child of
      childrenOf(node)
    ) {
      if (
        isContainer(child)
      ) {
        count++;
      }

      walk(child);
    }
  }


  walk(root);

  return count;
}


/* =========================================================
   WORKING COPY
========================================================= */

function createWorkingCopy(
  original
) {
  const page =
    figma.currentPage;


  const clone =
    original.clone();


  page.appendChild(
    clone
  );


  clone.x =
    original.x +
    WORK_OFFSET;


  clone.y =
    original.y;


  return clone;
}


/* =========================================================
   PROCESS GARBAGE
========================================================= */

async function processGarbage(
  originalRoot,
  workRoot,
  stats
) {
  /*
   * Original ID → Path
   */
  const originalMap =
    createPathMap(
      originalRoot
    );


  /*
   * 먼저 Working node refs를 확보.
   *
   * 부모 삭제로 path가 바뀌어도
   * SceneNode ref 자체는 유지된다.
   */
  const targets =
    [];


  for (
    const originalId of
    approvedGarbageIds
  ) {
    const path =
      originalMap.get(
        originalId
      );


    if (!path) {
      continue;
    }


    const workNode =
      resolvePath(
        workRoot,
        path
      );


    if (
      workNode &&
      getGarbageReason(
        workNode
      )
    ) {
      targets.push(
        workNode
      );
    }
  }


  /*
   * 부모 Garbage부터 삭제.
   *
   * 그러면 자식은 자동으로 사라진다.
   */
  targets.sort(
    (a, b) => {
      const pa =
        getPathFromRoot(
          workRoot,
          a
        );

      const pb =
        getPathFromRoot(
          workRoot,
          b
        );


      return (
        (pa ? pa.length : 999) -
        (pb ? pb.length : 999)
      );
    }
  );


  for (
    const target of targets
  ) {
    if (!isAlive(target)) {
      continue;
    }


    const path =
      getPathFromRoot(
        workRoot,
        target
      );


    if (!path) {
      continue;
    }


    const tx =
      await visualTransaction(
        workRoot,

        async currentRoot => {
          const current =
            resolvePath(
              currentRoot,
              path
            );


          return await deleteGarbageNode(
            currentRoot,
            current
          );
        }
      );


    workRoot =
      tx.root;


    if (
      tx.accepted
    ) {
      stats.removedGarbage++;

    } else if (
      tx.changed
    ) {
      /*
       * 삭제했더니 화면이 움직였음.
       * → 삭제 자동 취소.
       */
      stats.protectedGarbage++;
      stats.visualRejected++;
    }
  }


  return workRoot;
}


/* =========================================================
   PROCESS INSTANCES
========================================================= */

async function processInstances(
  workRoot,
  stats
) {
  const attempted =
    new Set();


  for (
    let pass = 0;
    pass < MAX_INSTANCE_PASSES;
    pass++
  ) {
    const paths =
      getInstancePaths(
        workRoot
      );


    let didSomething =
      false;


    for (
      const path of paths
    ) {
      const key =
        path.join("/");


      if (
        attempted.has(key)
      ) {
        continue;
      }


      attempted.add(key);


      const tx =
        await visualTransaction(
          workRoot,

          async root =>
            await attemptDetachInstance(
              root,
              path
            )
        );


      workRoot =
        tx.root;


      if (
        tx.accepted
      ) {
        stats.detachedInstances++;

        didSomething =
          true;

      } else if (
        tx.changed
      ) {
        stats.preservedAreas++;
        stats.visualRejected++;
      }
    }


    if (!didSomething) {
      break;
    }
  }


  return workRoot;
}


/* =========================================================
   PROCESS FLATTEN
========================================================= */

async function processFlatten(
  workRoot,
  stats
) {
  /*
   * 실패한 구조 Path.
   *
   * 같은 Frame을 무한 재시도하지 않음.
   */
  const rejected =
    new Set();


  for (
    let pass = 0;
    pass < MAX_FLATTEN_PASSES;
    pass++
  ) {
    const candidates =
      collectFlattenPaths(
        workRoot
      );


    let successInPass =
      false;


    for (
      const path of candidates
    ) {
      const key =
        path.join("/");


      if (
        rejected.has(key)
      ) {
        continue;
      }


      const tx =
        await visualTransaction(
          workRoot,

          async root =>
            await flattenOneLevel(
              root,
              path
            )
        );


      workRoot =
        tx.root;


      if (
        tx.accepted
      ) {
        successInPass =
          true;


        if (
          tx.data
        ) {
          stats.removedContainers +=
            tx.data.removed || 0;


          stats.movedLayers +=
            tx.data.moved || 0;


          stats.visualShells +=
            tx.data.shells || 0;
        }

      } else if (
        tx.changed
      ) {
        /*
         * 실제 Flatten은 됐지만
         * 렌더가 달라져서 Rollback됨.
         */
        rejected.add(
          key
        );


        stats.preservedAreas++;
        stats.visualRejected++;

      } else {
        /*
         * 기술적으로 Flatten 불가.
         */
        rejected.add(
          key
        );
      }
    }


    if (!successInPass) {
      break;
    }


    /*
     * 구조 변경 후 Path가 달라질 수 있으므로
     * 다음 Pass에서는 rejected 초기화.
     *
     * 이미 성공하면서 구조 자체가 달라졌기 때문.
     */
    rejected.clear();
  }


  return workRoot;
}


/* =========================================================
   PROCESS INTER
   ---------------------------------------------------------
   Inter 변경조차 Visual이 바뀌면 자동 Rollback.

   따라서 제1법칙이 항상 우선.
========================================================= */

async function processInter(
  workRoot,
  stats
) {
  if (
    !convertFontToInter
  ) {
    return workRoot;
  }


  const paths =
    collectTextPaths(
      workRoot
    );


  for (
    const path of paths
  ) {
    const tx =
      await visualTransaction(
        workRoot,

        async root => {
          const textNode =
            resolvePath(
              root,
              path
            );


          if (
            !textNode ||
            safeType(textNode) !==
              "TEXT"
          ) {
            return {
              root,

              changed:
                false,

              converted:
                0
            };
          }


          const count =
            await convertTextToInter(
              textNode
            );


          return {
            root,

            changed:
              count > 0,

            converted:
              count
          };
        }
      );


    workRoot =
      tx.root;


    if (
      tx.accepted
    ) {
      stats.convertedTexts++;

      stats.convertedFontSegments +=
        (
          tx.data &&
          tx.data.converted
        )
          ? tx.data.converted
          : 0;

    } else if (
      tx.changed
    ) {
      /*
       * Inter 때문에 실제 렌더가 바뀜.
       *
       * 제1법칙상 자동 취소.
       */
      stats.failedFontConversions++;
      stats.visualRejected++;
    }
  }


  return workRoot;
}


/* =========================================================
   PROCESS ORDER
========================================================= */

async function processOrder(
  workRoot,
  stats
) {
  const tx =
    await visualTransaction(
      workRoot,

      async root =>
        await attemptSpatialOrder(
          root
        )
    );


  workRoot =
    tx.root;


  if (
    !tx.accepted &&
    tx.changed
  ) {
    /*
     * 순서를 바꾸니 화면이 바뀌면
     * 원래 Z-order 유지.
     */
    stats.visualRejected++;
  }


  return workRoot;
}


/* =========================================================
   ANALYZE
========================================================= */

function analyzeScreen(root) {
  const garbageItems =
    collectGarbageItems(
      root
    );


  const result = {
    total:
      1 +
      countLayers(root),

    garbage:
      garbageItems.length,

    garbageItems,

    containers:
      countContainers(root),

    instances:
      0,

    autoLayouts:
      0,

    masks:
      0,

    clips:
      0,

    text:
      0,

    nonInterText:
      0,

    icons:
      0,

    lines:
      0,

    bakeCandidates:
      0
  };


  function walk(node) {
    if (!isAlive(node)) {
      return;
    }


    if (
      safeType(node) ===
      "INSTANCE"
    ) {
      result.instances++;
    }


    if (
      isAutoLayout(node)
    ) {
      result.autoLayouts++;
    }


    try {
      if (
        "isMask" in node &&
        node.isMask === true
      ) {
        result.masks++;
      }
    } catch (_) {}


    if (
      safeType(node) ===
      "TEXT"
    ) {
      result.text++;


      try {
        const segments =
          node.getStyledTextSegments(
            ["fontName"]
          );


        if (
          segments.some(
            segment =>
              !segment.fontName ||
              segment.fontName ===
                figma.mixed ||
              segment.fontName.family !==
                "Inter"
          )
        ) {
          result.nonInterText++;
        }

      } catch (_) {
        result.nonInterText++;
      }
    }


    if (
      looksLikeIcon(node)
    ) {
      result.icons++;
    }


    if (
      safeType(node) ===
      "LINE"
    ) {
      result.lines++;
    }


    for (
      const child of
      childrenOf(node)
    ) {
      walk(child);
    }
  }


  walk(root);


  return result;
}


/* =========================================================
   COMMIT
========================================================= */

function commitWorkingCopy(
  original,
  working
) {
  if (
    !isAlive(original) ||
    !isAlive(working)
  ) {
    return working;
  }


  const parent =
    safeParent(
      original
    );


  /*
   * Strict 버전에서는
   * Page 직속 Screen만 실제 교체.
   *
   * 다른 Frame/Auto Layout 내부의 Root를
   * 교체하면 주변 Layout까지 영향을 줄 수 있음.
   */
  if (
    !parent ||
    safeType(parent) !== "PAGE"
  ) {
    return null;
  }


  let index =
    0;


  try {
    index =
      parent.children.indexOf(
        original
      );
  } catch (_) {}


  const originalX =
    original.x;

  const originalY =
    original.y;


  /*
   * Working Copy를 원래 자리로.
   */
  working.x =
    originalX;

  working.y =
    originalY;


  parent.insertChild(
    Math.max(
      index,
      0
    ),
    working
  );


  /*
   * 원본 제거.
   */
  original.remove();


  return working;
}


/* =========================================================
   PROCESS ROOT
========================================================= */

async function processRoot(
  originalRoot
) {
  const stats =
    createStats();


  if (!isAlive(originalRoot)) {
    return {
      success:
        false,

      root:
        originalRoot,

      stats
    };
  }


  /*
   * Root가 Page 직속이 아니라면
   * 제1법칙상 구조 교체 금지.
   */
  const originalParent =
    safeParent(
      originalRoot
    );


  if (
    !originalParent ||
    safeType(
      originalParent
    ) !== "PAGE"
  ) {
    /*
     * 이름 변경조차 하지 않고
     * 그대로 유지.
     */
    stats.preservedAreas++;


    return {
      success:
        true,

      root:
        originalRoot,

      stats
    };
  }


  /* =====================================================
     1. ORIGINAL BASELINE
  ===================================================== */

  const originalPng =
    await exportNodePng(
      originalRoot
    );


  if (!originalPng) {
    return {
      success:
        false,

      root:
        originalRoot,

      stats
    };
  }


  /* =====================================================
     2. WORKING COPY
  ===================================================== */

  let workRoot = null;


  try {
    workRoot =
      createWorkingCopy(
        originalRoot
      );

  } catch (error) {
    console.warn(
      "Working copy failed:",
      error
    );


    return {
      success:
        false,

      root:
        originalRoot,

      stats
    };
  }


  /*
   * Clone 자체가 원본과 이미 다른지 확인.
   */
  const clonePng =
    await exportNodePng(
      workRoot
    );


  if (
    !clonePng ||
    !sameBytes(
      originalPng,
      clonePng
    )
  ) {
    safeRemove(
      workRoot
    );


    stats.visualRejected++;


    return {
      success:
        true,

      root:
        originalRoot,

      stats
    };
  }


  /* =====================================================
     3. GARBAGE
  ===================================================== */

  workRoot =
    await processGarbage(
      originalRoot,
      workRoot,
      stats
    );


  /* =====================================================
     4. INSTANCE
  ===================================================== */

  workRoot =
    await processInstances(
      workRoot,
      stats
    );


  /* =====================================================
     5. FRAME / GROUP FLATTEN
  ===================================================== */

  workRoot =
    await processFlatten(
      workRoot,
      stats
    );


  /* =====================================================
     6. INTER
     Visual 변경되면 자동 취소.
  ===================================================== */

  workRoot =
    await processInter(
      workRoot,
      stats
    );


  /* =====================================================
     7. NAMES
     이름은 렌더에 영향 없음.
  ===================================================== */

  await normalizeNamesRecursive(
    workRoot,
    workRoot
  );


  /* =====================================================
     8. ORDER
     Visual 변경되면 자동 취소.
  ===================================================== */

  workRoot =
    await processOrder(
      workRoot,
      stats
    );


  /* =====================================================
     9. FINAL VISUAL VERIFICATION
  ===================================================== */

  const finalPng =
    await exportNodePng(
      workRoot
    );


  if (
    !finalPng ||
    !sameBytes(
      originalPng,
      finalPng
    )
  ) {
    /*
     * 무슨 일이 있어도
     * 원본은 건드리지 않는다.
     */
    safeRemove(
      workRoot
    );


    stats.visualRejected++;


    return {
      success:
        true,

      root:
        originalRoot,

      stats
    };
  }


  /* =====================================================
     10. COMMIT
  ===================================================== */

  const committedRoot =
    commitWorkingCopy(
      originalRoot,
      workRoot
    );


  if (!committedRoot) {
    /*
     * Commit 자체가 안전하지 않은 구조.
     */
    safeRemove(
      workRoot
    );


    stats.preservedAreas++;


    return {
      success:
        true,

      root:
        originalRoot,

      stats
    };
  }


  stats.finalLayers =
    childrenOf(
      committedRoot
    ).length;


  return {
    success:
      true,

    root:
      committedRoot,

    stats
  };
}


/* =========================================================
   UI
========================================================= */

figma.ui.onmessage =
async msg => {


  /* =====================================================
     CLOSE
  ===================================================== */

  if (
    msg.type === "close"
  ) {
    figma.closePlugin();

    return;
  }


  /* =====================================================
     GARBAGE DETAIL
  ===================================================== */

  if (
    msg.type ===
    "select-layer"
  ) {
    try {
      const node =
        await figma.getNodeByIdAsync(
          msg.nodeId
        );


      if (
        !node ||
        node.type ===
          "DOCUMENT" ||
        node.type ===
          "PAGE"
      ) {
        return;
      }


      figma.currentPage.selection =
        [node];


      figma.viewport
        .scrollAndZoomIntoView(
          [node]
        );

    } catch (_) {}


    return;
  }


  /* =====================================================
     SELECTION
  ===================================================== */

  const selection =
    [...figma.currentPage.selection]
      .filter(
        node =>
          isAlive(node)
      );


  if (
    selection.length === 0
  ) {
    figma.ui.postMessage({
      type:
        "error",

      message:
        "정리할 최상위 Screen Layer를 선택해주세요."
    });


    return;
  }


  if (
    !selection.every(
      isSupportedRoot
    )
  ) {
    figma.ui.postMessage({
      type:
        "error",

      message:
`지원하지 않는 Layer가 포함되어 있습니다.

지원 타입
• Frame
• Instance
• Component
• Group`
    });


    return;
  }


  /* =====================================================
     ANALYZE
  ===================================================== */

  if (
    msg.type ===
    "analyze"
  ) {
    const results =
      selection.map(
        root => ({
          name:
            safeName(root),

          rootType:
            safeType(root),

          willConvertToFrame:
            false,

          ...analyzeScreen(
            root
          )
        })
      );


    figma.ui.postMessage({
      type:
        "analysis",

      results
    });


    return;
  }


  /* =====================================================
     CLEAN
  ===================================================== */

  if (
    msg.type ===
    "clean"
  ) {
    approvedGarbageIds =
      new Set(
        msg.garbageIds ||
        []
      );


    renameTextToHyphen =
      msg.renameTextToHyphen ===
      true;


    convertFontToInter =
      msg.convertFontToInter ===
      true;


    figma.ui.postMessage({
      type:
        "processing"
    });


    const roots =
      [];


    const total = {
      screens:
        selection.length,

      committed: 0,
      rolledBack: 0,

      detachedInstances: 0,

      removedGarbage: 0,
      protectedGarbage: 0,

      removedContainers: 0,
      movedLayers: 0,

      preservedAreas: 0,

      convertedTexts: 0,
      convertedFontSegments: 0,
      failedFontConversions: 0,

      visualShells: 0,
      bakedAreas: 0,

      visualRejected: 0,

      finalLayers: 0
    };


    try {
      for (
        const originalRoot of
        selection
      ) {
        try {
          const result =
            await processRoot(
              originalRoot
            );


          if (
            result.root &&
            isAlive(
              result.root
            )
          ) {
            roots.push(
              result.root
            );
          }


          if (
            result.success
          ) {
            total.committed++;

          } else {
            total.rolledBack++;
          }


          for (
            const key of
            Object.keys(
              result.stats
            )
          ) {
            if (
              key in total
            ) {
              total[key] +=
                result.stats[key];
            }
          }

        } catch (error) {
          console.error(
            "Screen cleanup error:",
            safeName(
              originalRoot
            ),
            error
          );


          /*
           * 이 경우도 Original은
           * 아직 손대지 않았으므로 그대로.
           */
          if (
            isAlive(
              originalRoot
            )
          ) {
            roots.push(
              originalRoot
            );
          }


          total.rolledBack++;
        }
      }


      const validRoots =
        roots.filter(
          root =>
            isAlive(root)
        );


      if (
        validRoots.length > 0
      ) {
        figma.currentPage.selection =
          validRoots;


        figma.viewport
          .scrollAndZoomIntoView(
            validRoots
          );
      }


      figma.ui.postMessage({
        type:
          "complete",

        result:
          total
      });


      if (
        total.visualRejected > 0
      ) {
        figma.notify(
          `Cleanup 완료 · 화면 변화가 감지된 ${total.visualRejected}개 작업은 자동 취소했습니다.`
        );

      } else {
        figma.notify(
          `Cleanup 완료 · Garbage ${total.removedGarbage}개 삭제 / Container ${total.removedContainers}개 정리`
        );
      }


    } catch (error) {
      console.error(
        "Cleanup error:",
        error
      );


      figma.ui.postMessage({
        type:
          "error",

        message:
          "Cleanup 중 오류가 발생했습니다.\n\n" +
          (
            error &&
            error.message
              ? error.message
              : String(error)
          )
      });
    }
  }
};
