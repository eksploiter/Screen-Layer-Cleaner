figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER
   SAFE VISUAL-FIRST VERSION

   제1법칙
   ---------------------------------------------------------
   디자인 화면에 영향을 주지 않는다.

   우선순위
   ---------------------------------------------------------
   1. Visual Preservation
   2. Garbage Cleanup
   3. LID Preservation
   4. Layer Naming
   5. Safe Flatten
   6. Layer Ordering

   핵심 원칙
   ---------------------------------------------------------
   - 1 Depth가 가능하면 Flatten
   - 조금이라도 위험하면 Container 유지
   - Auto Layout은 구조 변경하지 않음
   - Mask / Clip / Effect 구조 유지
   - Screenshot Bake 사용하지 않음
   - 화면 보존 때문에 Frame/Group이 남는 것은 정상
   - 개별 Layer 실패가 전체 Screen 실패로 이어지지 않음
========================================================= */


/* =========================================================
   GLOBAL
========================================================= */

let renameTextToHyphen = false;
let convertFontToInter = false;

let approvedGarbageIds = new Set();
let approvedGarbagePaths = new Set();

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

    /*
     * 기존 UI 호환용.
     * 이번 버전에서는 Bake하지 않는다.
     */
    bakedAreas: 0,

    finalLayers: 0
  };
}


/* =========================================================
   SAFE NODE ACCESS
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


function safeAbsoluteTransform(node) {
  try {
    return node.absoluteTransform;
  } catch (_) {
    return null;
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


function safeRemove(node) {
  if (!isAlive(node)) {
    return false;
  }

  try {
    node.remove();

    return true;

  } catch (error) {
    console.warn(
      "Remove skipped:",
      safeName(node),
      error
    );

    return false;
  }
}


function hasChildren(node) {
  if (!isAlive(node)) {
    return false;
  }

  try {
    return (
      "children" in node &&
      node.children != null
    );

  } catch (_) {
    return false;
  }
}


function childrenOf(node) {
  if (!hasChildren(node)) {
    return [];
  }

  try {
    return [...node.children];
  } catch (_) {
    return [];
  }
}


/* =========================================================
   NODE TYPES
========================================================= */

function isContainer(node) {
  const type =
    safeType(node);

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


function isInsideInstance(node) {
  let current =
    safeParent(node);


  while (current) {
    if (
      safeType(current) ===
      "INSTANCE"
    ) {
      return true;
    }

    current =
      safeParent(current);
  }


  return false;
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
      "Transform matrix cannot be inverted."
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
    safeAbsoluteTransform(
      parent
    );


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
========================================================= */

/*
 * Instance Detach 등으로 ID가 달라질 수 있으므로
 * Garbage 선택은 구조 Path도 같이 저장한다.
 */

function buildPathMap(root) {
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
        path
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

        path === ""
          ? String(i)
          : `${path}/${i}`
      );
    }
  }


  walk(
    root,
    ""
  );


  return map;
}


function prepareGarbagePaths(root) {
  const pathMap =
    buildPathMap(root);


  const result =
    new Set();


  for (
    const id of
    approvedGarbageIds
  ) {
    const path =
      pathMap.get(id);


    if (
      path !== undefined
    ) {
      result.add(path);
    }
  }


  return result;
}


/* =========================================================
   LID PROTECTION
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
    value.startsWith("cci_ctn_") ||
    value.startsWith("cci_msg_") ||
    value.startsWith("ctn_") ||
    value.startsWith("msg_")
  );
}


/* =========================================================
   AUTO LAYOUT
========================================================= */

function isAutoLayout(node) {
  if (!isAlive(node)) {
    return false;
  }


  try {
    return (
      "layoutMode" in node &&
      node.layoutMode !== "NONE"
    );

  } catch (_) {
    return false;
  }
}


/*
 * node의 Parent부터 root까지
 * Auto Layout이 하나라도 존재하는지.
 *
 * Auto Layout 내부의 Layer를 밖으로 빼면
 * 위치 / 크기 / spacing이 달라질 수 있으므로
 * Flatten 금지.
 */
function hasAutoLayoutAncestorUntilRoot(
  node,
  root
) {
  let current =
    safeParent(node);


  while (current) {
    if (
      isAutoLayout(current)
    ) {
      return true;
    }


    if (
      current === root
    ) {
      break;
    }


    current =
      safeParent(current);
  }


  return false;
}


/*
 * Auto Layout 안에서 실제 Layout에
 * 참여하는 Layer인지 확인.
 */
function participatesInAutoLayout(node) {
  const parent =
    safeParent(node);


  if (
    !parent ||
    !isAutoLayout(parent)
  ) {
    return false;
  }


  try {
    if (
      "layoutPositioning" in node &&
      node.layoutPositioning ===
        "ABSOLUTE"
    ) {
      return false;
    }
  } catch (_) {}


  return true;
}


/* =========================================================
   PAINT
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


function hasImageFill(node) {
  if (!isAlive(node)) {
    return false;
  }


  try {
    if (
      !("fills" in node) ||
      node.fills === figma.mixed ||
      !Array.isArray(node.fills)
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


function hasOwnVisual(node) {
  if (!isAlive(node)) {
    return false;
  }


  try {
    if (
      "fills" in node &&
      node.fills !== figma.mixed &&
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
      node.strokes !== figma.mixed &&
      hasVisiblePaint(
        node.strokes
      )
    ) {
      return true;
    }
  } catch (_) {}


  return false;
}


function hasVisibleEffects(node) {
  if (!isAlive(node)) {
    return false;
  }


  try {
    if (
      !("effects" in node) ||
      !Array.isArray(node.effects)
    ) {
      return false;
    }


    return node.effects.some(
      effect =>
        effect.visible !== false
    );

  } catch (_) {
    return false;
  }
}


/* =========================================================
   MASK / CLIP
========================================================= */

function containsMask(node) {
  for (
    const child of
    childrenOf(node)
  ) {
    if (!isAlive(child)) {
      continue;
    }


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


function actuallyClipsChildren(node) {
  if (!isAlive(node)) {
    return false;
  }


  try {
    if (
      !("clipsContent" in node) ||
      node.clipsContent !== true
    ) {
      return false;
    }
  } catch (_) {
    return false;
  }


  const bounds =
    safeBounds(node);


  if (!bounds) {
    return true;
  }


  const left =
    bounds.x;

  const top =
    bounds.y;

  const right =
    bounds.x +
    bounds.width;

  const bottom =
    bounds.y +
    bounds.height;


  for (
    const child of
    childrenOf(node)
  ) {
    if (!isAlive(child)) {
      continue;
    }


    try {
      if (
        "visible" in child &&
        child.visible === false
      ) {
        continue;
      }
    } catch (_) {}


    const childBounds =
      safeRenderBounds(child);


    if (!childBounds) {
      continue;
    }


    if (
      childBounds.x <
        left - 0.5 ||

      childBounds.y <
        top - 0.5 ||

      childBounds.x +
        childBounds.width >
        right + 0.5 ||

      childBounds.y +
        childBounds.height >
        bottom + 0.5
    ) {
      return true;
    }
  }


  return false;
}


/* =========================================================
   ROTATION / TRANSFORM SAFETY
========================================================= */

function hasRotation(node) {
  try {
    if (
      "rotation" in node &&
      typeof node.rotation ===
        "number"
    ) {
      return (
        Math.abs(
          node.rotation
        ) >
        0.001
      );
    }
  } catch (_) {}


  return false;
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
    safeType(node) === "SLICE"
  ) {
    return "Slice Layer";
  }


  return null;
}


function isSelectedGarbage(
  node,
  path
) {
  if (
    getGarbageReason(node) ===
    null
  ) {
    return false;
  }


  const id =
    safeId(node);


  if (
    id &&
    approvedGarbageIds.has(id)
  ) {
    return true;
  }


  if (
    path !== undefined &&
    approvedGarbagePaths.has(path)
  ) {
    return true;
  }


  return false;
}


/*
 * Garbage라고 해도 삭제 때문에
 * 화면 배치가 변할 수 있으면 삭제하지 않는다.

 * 특히 opacity 0 Layer가 Auto Layout에서
 * spacing을 차지하는 경우.
 */
function canDeleteGarbageSafely(node) {
  const reason =
    getGarbageReason(node);


  if (!reason) {
    return false;
  }


  /*
   * Slice는 Visual/Layout 영향 없음.
   */
  if (
    safeType(node) === "SLICE"
  ) {
    return true;
  }


  /*
   * Auto Layout에 참여 중이면
   * 삭제하지 않는다.
   */
  if (
    participatesInAutoLayout(node)
  ) {
    return false;
  }


  return true;
}


/* =========================================================
   FONT
========================================================= */

const loadedFonts =
  new Set();


async function loadFontOnce(
  fontName
) {
  if (
    !fontName ||
    fontName === figma.mixed
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


    loadedFonts.add(key);


    return true;

  } catch (error) {
    console.warn(
      "Font load skipped:",
      fontName.family,
      fontName.style
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


      const loaded =
        await loadFontOnce(
          segment.fontName
        );


      if (!loaded) {
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


/* =========================================================
   INTER
========================================================= */

const loadedInterStyles =
  new Set();


function mapFontStyleToInter(
  sourceStyle
) {
  const value =
    String(
      sourceStyle || ""
    )
      .toLowerCase()
      .replace(
        /[_-]/g,
        " "
      );


  const italic =
    value.includes("italic") ||
    value.includes("oblique");


  let style =
    "Regular";


  if (
    value.includes("black") ||
    value.includes("heavy")
  ) {
    style =
      "Black";

  } else if (
    value.includes("extra bold") ||
    value.includes("extrabold")
  ) {
    style =
      "Extra Bold";

  } else if (
    value.includes("semi bold") ||
    value.includes("semibold")
  ) {
    style =
      "Semi Bold";

  } else if (
    value.includes("bold")
  ) {
    style =
      "Bold";

  } else if (
    value.includes("medium")
  ) {
    style =
      "Medium";

  } else if (
    value.includes("extra light") ||
    value.includes("extralight")
  ) {
    style =
      "Extra Light";

  } else if (
    value.includes("light")
  ) {
    style =
      "Light";

  } else if (
    value.includes("thin")
  ) {
    style =
      "Thin";
  }


  if (italic) {
    return (
      style === "Regular"
        ? "Italic"
        : `${style} Italic`
    );
  }


  return style;
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


/*
 * Inter 변환은 구조와 위치를
 * 움직이지 않는 경우에만 실행.

 * Auto Layout 안이라고 해서 Font 변환 자체를
 * 막지는 않지만, Text 위치는 절대 변경하지 않는다.
 */
async function convertTextToInter(
  node
) {
  if (
    safeType(node) !==
    "TEXT"
  ) {
    return 0;
  }


  const fontsReady =
    await ensureTextFontsLoaded(
      node
    );


  if (!fontsReady) {
    return 0;
  }


  /*
   * 기존 위치 저장.
   *
   * Font 변경 후 Auto Resize 때문에
   * x/y가 달라지는 경우 방지.
   */
  let originalX = null;
  let originalY = null;


  try {
    originalX = node.x;
    originalY = node.y;
  } catch (_) {}


  try {
    const segments =
      node.getStyledTextSegments(
        ["fontName"]
      );


    let converted = 0;


    for (
      const segment of segments
    ) {
      const sourceStyle =
        segment.fontName &&
        segment.fontName !==
          figma.mixed
          ? segment.fontName.style
          : "Regular";


      const targetStyle =
        await loadInterStyle(
          mapFontStyleToInter(
            sourceStyle
          )
        );


      if (!targetStyle) {
        continue;
      }


      node.setRangeFontName(
        segment.start,
        segment.end,
        {
          family:
            "Inter",

          style:
            targetStyle
        }
      );


      converted++;
    }


    /*
     * Auto Layout이 아닌 경우만
     * x/y 복원.
     *
     * Auto Layout Child는 x/y 직접 설정이
     * 레이아웃에 영향을 줄 수 있으므로 제외.
     */
    if (
      !participatesInAutoLayout(node) &&
      originalX !== null &&
      originalY !== null
    ) {
      try {
        node.x =
          originalX;

        node.y =
          originalY;
      } catch (_) {}
    }


    return converted;

  } catch (error) {
    console.warn(
      "Inter conversion skipped:",
      safeName(node),
      error
    );


    return 0;
  }
}


/* =========================================================
   NAMING
========================================================= */

function looksLikeIcon(node) {
  const type =
    safeType(node);


  const name =
    safeName(node)
      .toLowerCase();


  if (
    type === "VECTOR" ||
    type === "BOOLEAN_OPERATION" ||
    type === "POLYGON" ||
    type === "STAR"
  ) {
    return true;
  }


  if (
    type === "ELLIPSE"
  ) {
    return (
      name.includes("icon") ||
      name.includes("ic_") ||
      name.startsWith("ic/")
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


  const name =
    safeName(node)
      .toLowerCase();


  if (
    name.includes("screenshot") ||
    name.includes("screen shot") ||
    name.includes("스크린샷")
  ) {
    return true;
  }


  try {
    if (
      !root ||
      root.width <= 0 ||
      root.height <= 0
    ) {
      return false;
    }


    return (
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


function looksLikeIPhoneFrame(node) {
  if (
    safeType(node) !==
    "FRAME"
  ) {
    return false;
  }


  const name =
    safeName(node)
      .toLowerCase();


  return (
    name.includes("iphone") ||
    name.includes("i phone")
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


  const originalName =
    safeName(node);


  /* -----------------------------------------------------
     TEXT
  ----------------------------------------------------- */

  if (
    type === "TEXT"
  ) {
    /*
     * LID 무조건 유지.
     */
    if (
      isLidName(
        originalName
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


  /* -----------------------------------------------------
     LINE
  ----------------------------------------------------- */

  if (
    type === "LINE"
  ) {
    try {
      node.name =
        "line";
    } catch (_) {}


    return;
  }


  /* -----------------------------------------------------
     ICON
  ----------------------------------------------------- */

  if (
    looksLikeIcon(node)
  ) {
    try {
      node.name =
        "icon";
    } catch (_) {}


    return;
  }


  /* -----------------------------------------------------
     RECTANGLE
  ----------------------------------------------------- */

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


  /* -----------------------------------------------------
     ELLIPSE
  ----------------------------------------------------- */

  if (
    type === "ELLIPSE"
  ) {
    try {
      node.name =
        "shape";
    } catch (_) {}


    return;
  }


  /* -----------------------------------------------------
     GROUP
  ----------------------------------------------------- */

  if (
    type === "GROUP"
  ) {
    try {
      node.name =
        "group";
    } catch (_) {}


    return;
  }


  /* -----------------------------------------------------
     FRAME
  ----------------------------------------------------- */

  if (
    type === "FRAME"
  ) {
    try {
      node.name =
        looksLikeIPhoneFrame(
          node
        )
          ? "iphone"
          : "frame";
    } catch (_) {}


    return;
  }


  /* -----------------------------------------------------
     COMPONENT
  ----------------------------------------------------- */

  if (
    type === "COMPONENT"
  ) {
    try {
      node.name =
        "component";
    } catch (_) {}


    return;
  }


  /* -----------------------------------------------------
     INSTANCE
  ----------------------------------------------------- */

  if (
    type === "INSTANCE"
  ) {
    try {
      node.name =
        "instance";
    } catch (_) {}
  }
}


/* =========================================================
   SAFE FLATTEN CHECK
========================================================= */

/*
 * TRUE일 때만 Container를 제거한다.

 * 조금이라도 화면 변화 가능성이 있으면 FALSE.
 */
function canFlattenContainerSafely(
  node,
  root
) {
  if (!isContainer(node)) {
    return false;
  }


  /*
   * Instance는 먼저 Detach해야 함.
   */
  if (
    safeType(node) ===
    "INSTANCE"
  ) {
    return false;
  }


  /*
   * Auto Layout 자체 제거 금지.
   */
  if (
    isAutoLayout(node)
  ) {
    return false;
  }


  /*
   * Auto Layout 내부 Container 제거 금지.
   */
  if (
    hasAutoLayoutAncestorUntilRoot(
      node,
      root
    )
  ) {
    return false;
  }


  /*
   * Container 자체 Fill / Stroke가 있으면
   * 제거 시 Visual 재현이 필요하므로 Preserve.
   *
   * 제1법칙 때문에 Shell 복제를 하지 않는다.
   */
  if (
    hasOwnVisual(node)
  ) {
    return false;
  }


  if (
    containsMask(node)
  ) {
    return false;
  }


  if (
    actuallyClipsChildren(node)
  ) {
    return false;
  }


  if (
    hasVisibleEffects(node)
  ) {
    return false;
  }


  if (
    hasRotation(node)
  ) {
    return false;
  }


  try {
    if (
      "opacity" in node &&
      node.opacity !== 1
    ) {
      return false;
    }
  } catch (_) {}


  try {
    if (
      "blendMode" in node &&
      node.blendMode !==
        "PASS_THROUGH" &&
      node.blendMode !==
        "NORMAL"
    ) {
      return false;
    }
  } catch (_) {}


  return true;
}


/* =========================================================
   SAFE REPARENT CHECK
========================================================= */

function canReparentSafely(
  node,
  root
) {
  if (
    !isAlive(node) ||
    !isAlive(root)
  ) {
    return false;
  }


  /*
   * Instance 내부에서 밖으로 직접 빼지 않음.
   */
  if (
    isInsideInstance(node)
  ) {
    return false;
  }


  /*
   * Auto Layout에 의존하면 밖으로 이동 금지.
   */
  if (
    hasAutoLayoutAncestorUntilRoot(
      node,
      root
    )
  ) {
    return false;
  }


  return true;
}


/* =========================================================
   ROOT INSTANCE
========================================================= */

/*
 * 선택한 Root 자체가 Instance라면
 * Detach를 시도한다.

 * Detach는 현재 Visual에는 영향을 주지 않는
 * 구조 변경이므로 허용.
 *
 * 실패하면 그냥 Instance 상태 유지.
 */
function detachRootInstance(
  root,
  stats
) {
  if (
    safeType(root) !==
    "INSTANCE"
  ) {
    return root;
  }


  try {
    const detached =
      root.detachInstance();


    if (
      detached &&
      isAlive(detached)
    ) {
      stats.detachedInstances++;

      return detached;
    }

  } catch (error) {
    console.warn(
      "Root Instance preserved:",
      safeName(root),
      error
    );
  }


  return root;
}


/* =========================================================
   INSTANCE INSIDE SCREEN
========================================================= */

/*
 * 내부 Instance는 Detach를 시도하지만,
 *
 * Auto Layout 내에 있어도 Detach 자체는
 * 현재 Layout 위치를 바꾸지 않으므로 허용.
 *
 * 실패하면 Instance 그대로 Preserve.
 */
function tryDetachInstance(
  node,
  stats
) {
  if (
    safeType(node) !==
    "INSTANCE"
  ) {
    return node;
  }


  try {
    const detached =
      node.detachInstance();


    if (
      detached &&
      isAlive(detached)
    ) {
      stats.detachedInstances++;

      return detached;
    }

  } catch (error) {
    console.warn(
      "Instance detach skipped:",
      safeName(node)
    );
  }


  return node;
}


/* =========================================================
   PROCESS TEXT
========================================================= */

async function processTextNode(
  node,
  root,
  stats
) {
  if (
    !isAlive(node) ||
    safeType(node) !==
      "TEXT"
  ) {
    return;
  }


  /*
   * Inter는 옵션일 때만.
   */
  if (
    convertFontToInter
  ) {
    const converted =
      await convertTextToInter(
        node
      );


    if (
      converted > 0
    ) {
      stats.convertedTexts++;

      stats.convertedFontSegments +=
        converted;

    } else {
      stats.failedFontConversions++;
    }
  }


  normalizeLayerName(
    node,
    root
  );
}


/* =========================================================
   SAFE MOVE
========================================================= */

async function moveLeafToRootSafely(
  node,
  root,
  stats
) {
  if (
    !isAlive(node) ||
    !isAlive(root)
  ) {
    return false;
  }


  /*
   * 이미 Root 바로 아래.
   * 이동하지 않는다.
   */
  if (
    safeParent(node) === root
  ) {
    if (
      safeType(node) === "TEXT"
    ) {
      await processTextNode(
        node,
        root,
        stats
      );

    } else {
      normalizeLayerName(
        node,
        root
      );
    }


    return true;
  }


  if (
    !canReparentSafely(
      node,
      root
    )
  ) {
    return false;
  }


  if (
    safeType(node) ===
    "TEXT"
  ) {
    const ready =
      await ensureTextFontsLoaded(
        node
      );


    if (!ready) {
      return false;
    }
  }


  const transform =
    safeAbsoluteTransform(
      node
    );


  if (!transform) {
    return false;
  }


  try {
    root.appendChild(
      node
    );


    node.relativeTransform =
      absoluteToRelative(
        transform,
        root
      );


    if (
      safeType(node) === "TEXT"
    ) {
      await processTextNode(
        node,
        root,
        stats
      );

    } else {
      normalizeLayerName(
        node,
        root
      );
    }


    stats.movedLayers++;


    return true;

  } catch (error) {
    console.warn(
      "Safe reparent skipped:",
      safeName(node),
      error
    );


    return false;
  }
}


/* =========================================================
   RECURSIVE NAME NORMALIZATION
========================================================= */

/*
 * Preserve되는 Container 내부도
 * 이름 변경은 Visual에 영향이 없으므로 정리 가능.

 * 단 Instance 내부 Child는 이름 변경이
 * 제한될 수 있으므로 실패하면 그냥 넘어감.
 */
async function normalizeSubtreeNames(
  node,
  root,
  stats
) {
  if (!isAlive(node)) {
    return;
  }


  if (
    safeType(node) === "TEXT"
  ) {
    await processTextNode(
      node,
      root,
      stats
    );

  } else {
    normalizeLayerName(
      node,
      root
    );
  }


  for (
    const child of
    childrenOf(node)
  ) {
    await normalizeSubtreeNames(
      child,
      root,
      stats
    );
  }
}


/* =========================================================
   FLATTEN
========================================================= */

/*
 * 중요:
 *
 * Container가 안전하면:
 *
 * Frame
 *   ├ Text
 *   └ Shape
 *
 * →
 *
 * Root
 *   ├ Text
 *   └ Shape
 *
 *
 * 위험하면:
 *
 * Root
 *   └ frame
 *      ├ Text
 *      └ Shape
 *
 * 그대로 유지.
 */

async function flattenNodeSafely(
  node,
  root,
  stats,
  path
) {
  if (!isAlive(node)) {
    return true;
  }


  /* =====================================================
     GARBAGE
  ===================================================== */

  const garbageReason =
    getGarbageReason(node);


  if (garbageReason) {
    if (
      isSelectedGarbage(
        node,
        path
      )
    ) {
      if (
        canDeleteGarbageSafely(
          node
        )
      ) {
        if (
          safeRemove(node)
        ) {
          stats.removedGarbage++;

          return true;
        }

      } else {
        /*
         * 사용자가 체크했지만
         * 삭제 시 화면이 움직일 가능성이 있음.
         */
        stats.protectedGarbage++;
      }

    } else {
      stats.protectedGarbage++;
    }
  }


  /* =====================================================
     LEAF
  ===================================================== */

  if (
    !isContainer(node)
  ) {
    const moved =
      await moveLeafToRootSafely(
        node,
        root,
        stats
      );


    /*
     * 이동 불가라도 이름/Font는
     * 현재 위치에서 처리 가능.
     */
    if (!moved) {
      if (
        safeType(node) === "TEXT"
      ) {
        await processTextNode(
          node,
          root,
          stats
        );

      } else {
        normalizeLayerName(
          node,
          root
        );
      }
    }


    return moved;
  }


  /* =====================================================
     INSTANCE
  ===================================================== */

  if (
    safeType(node) ===
    "INSTANCE"
  ) {
    const detached =
      tryDetachInstance(
        node,
        stats
      );


    /*
     * Detach 실패.
     */
    if (
      safeType(detached) ===
        "INSTANCE"
    ) {
      normalizeLayerName(
        detached,
        root
      );


      stats.preservedAreas++;


      return true;
    }


    /*
     * Detach 성공.
     */
    node =
      detached;
  }


  /* =====================================================
     SAFE CHECK
  ===================================================== */

  if (
    !canFlattenContainerSafely(
      node,
      root
    )
  ) {
    /*
     * Container 그대로 유지.
     */
    await normalizeSubtreeNames(
      node,
      root,
      stats
    );


    stats.preservedAreas++;


    return true;
  }


  /* =====================================================
     SAFE CONTAINER
  ===================================================== */

  const children =
    childrenOf(node);


  let allMoved =
    true;


  for (
    let i = 0;
    i < children.length;
    i++
  ) {
    const child =
      children[i];


    if (!isAlive(child)) {
      continue;
    }


    const childPath =
      path === ""
        ? String(i)
        : `${path}/${i}`;


    const success =
      await flattenNodeSafely(
        child,
        root,
        stats,
        childPath
      );


    if (!success) {
      allMoved =
        false;
    }
  }


  /*
   * Container가 완전히 비어있는 경우에만 삭제.
   */
  if (
    isAlive(node) &&
    childrenOf(node)
      .length === 0
  ) {
    if (
      safeRemove(node)
    ) {
      stats.removedContainers++;


      return true;
    }
  }


  /*
   * Child 하나라도 남아있으면
   * 절대 Container 삭제하지 않는다.
   */
  if (
    isAlive(node)
  ) {
    normalizeLayerName(
      node,
      root
    );


    stats.preservedAreas++;
  }


  return allMoved;
}


/* =========================================================
   SAFE CLEAN ROOT
========================================================= */

async function cleanRoot(
  root,
  stats
) {
  /*
   * 중요:
   * Root Auto Layout은 절대 해제하지 않는다.
   */


  const children =
    childrenOf(root);


  for (
    let i = 0;
    i < children.length;
    i++
  ) {
    const child =
      children[i];


    if (!isAlive(child)) {
      continue;
    }


    try {
      await flattenNodeSafely(
        child,
        root,
        stats,
        String(i)
      );

    } catch (error) {
      /*
       * 개별 Layer 실패가
       * 전체 Screen 실패로 이어지지 않음.
       */
      console.warn(
        "Layer preserved:",
        safeName(child),
        error
      );


      stats.preservedAreas++;


      try {
        await normalizeSubtreeNames(
          child,
          root,
          stats
        );
      } catch (_) {}
    }
  }


  /*
   * 최종 Root Child 이름 정리.
   */
  for (
    const child of
    childrenOf(root)
  ) {
    try {
      normalizeLayerName(
        child,
        root
      );
    } catch (_) {}
  }


  stats.finalLayers =
    childrenOf(root)
      .length;
}


/* =========================================================
   LAYER ORDER
========================================================= */

function getSpatialBounds(node) {
  const bounds =
    safeBounds(node);


  if (!bounds) {
    return null;
  }


  return {
    x:
      bounds.x,

    y:
      bounds.y,

    width:
      bounds.width,

    height:
      bounds.height
  };
}


function boundsOverlap(
  a,
  b
) {
  if (
    !a ||
    !b
  ) {
    return false;
  }


  return !(
    a.x + a.width <=
      b.x ||

    b.x + b.width <=
      a.x ||

    a.y + a.height <=
      b.y ||

    b.y + b.height <=
      a.y
  );
}


/*
 * Layer Panel 읽기 순서:
 *
 * 1. 위 → 아래
 * 2. 같은 줄 → 좌 → 우
 *
 * LID / Text / Icon 등 종류를 구분하지 않는다.
 */
function compareSpatial(
  a,
  b
) {
  if (
    !a.bounds ||
    !b.bounds
  ) {
    return (
      a.originalPanelIndex -
      b.originalPanelIndex
    );
  }


  const aCenterY =
    a.bounds.y +
    a.bounds.height / 2;


  const bCenterY =
    b.bounds.y +
    b.bounds.height / 2;


  /*
   * 같은 줄
   */
  if (
    Math.abs(
      aCenterY -
      bCenterY
    ) <= ROW_TOLERANCE
  ) {
    const xDiff =
      a.bounds.x -
      b.bounds.x;


    if (
      Math.abs(xDiff) >
      0.1
    ) {
      return xDiff;
    }
  }


  /*
   * 위 → 아래
   */
  const yDiff =
    a.bounds.y -
    b.bounds.y;


  if (
    Math.abs(yDiff) >
    0.1
  ) {
    return yDiff;
  }


  const xDiff =
    a.bounds.x -
    b.bounds.x;


  if (
    Math.abs(xDiff) >
    0.1
  ) {
    return xDiff;
  }


  return (
    a.originalPanelIndex -
    b.originalPanelIndex
  );
}


/*
 * Auto Layout Root에서는
 * Layer 순서 변경 자체가 Layout에 영향을 줄 수 있으므로
 * 절대 정렬하지 않는다.
 *
 * 일반 Root에서는
 * 겹치는 Layer의 Z-order를 유지하면서
 * 나머지만 위치순 정렬.
 */
function sortLayersSafely(
  root
) {
  if (
    !isAlive(root)
  ) {
    return;
  }


  /*
   * Auto Layout Root 정렬 금지.
   */
  if (
    isAutoLayout(root)
  ) {
    console.log(
      "Layer order preserved: Root uses Auto Layout."
    );


    return;
  }


  const children =
    childrenOf(root);


  if (
    children.length <= 1
  ) {
    return;
  }


  /*
   * Panel 기준 현재 위 → 아래.
   */
  const panelOrder =
    [...children]
      .reverse();


  const items =
    panelOrder.map(
      (node, index) => ({
        node,

        bounds:
          getSpatialBounds(node),

        originalPanelIndex:
          index,

        outgoing:
          new Set(),

        indegree:
          0
      })
    );


  /*
   * 겹치는 Layer는
   * 기존 Z-order 관계를 고정.
   */
  for (
    let i = 0;
    i < items.length;
    i++
  ) {
    for (
      let j = i + 1;
      j < items.length;
      j++
    ) {
      const front =
        items[i];

      const back =
        items[j];


      if (
        boundsOverlap(
          front.bounds,
          back.bounds
        )
      ) {
        front.outgoing.add(
          back
        );


        back.indegree++;
      }
    }
  }


  /*
   * Z-order Constraint를 지키면서
   * 위치순으로 정렬.
   */
  const available =
    items.filter(
      item =>
        item.indegree === 0
    );


  const desiredPanelOrder =
    [];


  while (
    available.length > 0
  ) {
    available.sort(
      compareSpatial
    );


    const current =
      available.shift();


    desiredPanelOrder.push(
      current
    );


    for (
      const next of
      current.outgoing
    ) {
      next.indegree--;


      if (
        next.indegree === 0
      ) {
        available.push(
          next
        );
      }
    }
  }


  if (
    desiredPanelOrder.length !==
    items.length
  ) {
    console.warn(
      "Layer ordering skipped."
    );


    return;
  }


  /*
   * Layer Panel:
   *
   * A
   * B
   * C
   *
   * Figma children:
   *
   * C
   * B
   * A
   */
  const desiredChildren =
    desiredPanelOrder
      .map(
        item =>
          item.node
      )
      .reverse();


  for (
    let i = 0;
    i <
      desiredChildren.length;
    i++
  ) {
    const node =
      desiredChildren[i];


    if (!isAlive(node)) {
      continue;
    }


    try {
      root.insertChild(
        i,
        node
      );

    } catch (error) {
      console.warn(
        "Layer order preserved after error:",
        safeName(node)
      );


      return;
    }
  }
}


/* =========================================================
   ANALYZE
========================================================= */

function analyzeScreen(root) {
  const result = {
    total: 0,

    garbage: 0,
    garbageItems: [],

    containers: 0,

    instances: 0,
    autoLayouts: 0,

    masks: 0,
    clips: 0,

    text: 0,
    nonInterText: 0,

    icons: 0,
    lines: 0,

    /*
     * 기존 UI 호환.
     *
     * 이번에는 "Preserve Candidate" 의미.
     */
    bakeCandidates: 0
  };


  function walk(
    node,
    displayPath
  ) {
    if (!isAlive(node)) {
      return;
    }


    result.total++;


    const name =
      safeName(node);


    const currentPath =
      displayPath
        ? `${displayPath} / ${name}`
        : name;


    /* -------------------------------------------------
       Garbage
    ------------------------------------------------- */

    const garbageReason =
      getGarbageReason(node);


    if (garbageReason) {
      result.garbage++;


      result.garbageItems.push({
        id:
          safeId(node) || "",

        name,

        type:
          safeType(node) ||
          "UNKNOWN",

        reason:
          garbageReason,

        path:
          currentPath
      });
    }


    /* -------------------------------------------------
       Container
    ------------------------------------------------- */

    if (
      node !== root &&
      isContainer(node)
    ) {
      result.containers++;


      if (
        !canFlattenContainerSafely(
          node,
          root
        )
      ) {
        result.bakeCandidates++;
      }
    }


    /* -------------------------------------------------
       Instance
    ------------------------------------------------- */

    if (
      safeType(node) ===
      "INSTANCE"
    ) {
      result.instances++;
    }


    /* -------------------------------------------------
       Auto Layout
    ------------------------------------------------- */

    if (
      isAutoLayout(node)
    ) {
      result.autoLayouts++;
    }


    /* -------------------------------------------------
       Mask
    ------------------------------------------------- */

    try {
      if (
        "isMask" in node &&
        node.isMask === true
      ) {
        result.masks++;
      }
    } catch (_) {}


    /* -------------------------------------------------
       Clip
    ------------------------------------------------- */

    if (
      node !== root &&
      actuallyClipsChildren(
        node
      )
    ) {
      result.clips++;
    }


    /* -------------------------------------------------
       Text
    ------------------------------------------------- */

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


        const nonInter =
          segments.some(
            segment =>
              !segment.fontName ||
              segment.fontName ===
                figma.mixed ||
              segment.fontName.family !==
                "Inter"
          );


        if (nonInter) {
          result.nonInterText++;
        }

      } catch (_) {
        result.nonInterText++;
      }
    }


    /* -------------------------------------------------
       Icon
    ------------------------------------------------- */

    if (
      looksLikeIcon(node)
    ) {
      result.icons++;
    }


    /* -------------------------------------------------
       Line
    ------------------------------------------------- */

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
      walk(
        child,
        currentPath
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
   PROCESS ROOT
========================================================= */

async function processRoot(
  originalRoot
) {
  const stats =
    createStats();


  if (!isAlive(originalRoot)) {
    return {
      success: false,
      root: originalRoot,
      stats
    };
  }


  /*
   * Garbage Path는
   * 구조 변경 전에 확보.
   */
  approvedGarbagePaths =
    prepareGarbagePaths(
      originalRoot
    );


  let root =
    originalRoot;


  /*
   * 선택 Root 자체가 Instance일 경우에만
   * Detach를 시도.
   *
   * 부모 Instance를 강제로 Detach하지 않는다.
   * 주변 Screen까지 구조가 바뀔 수 있기 때문.
   */
  root =
    detachRootInstance(
      root,
      stats
    );


  if (
    !root ||
    !isAlive(root)
  ) {
    return {
      success: false,
      root: originalRoot,
      stats
    };
  }


  /*
   * 여전히 다른 Instance 내부라면
   * 구조 변경은 하지 않는다.
   *
   * 이름 정리 / Inter 같은
   * 비구조 작업만 가능한 범위에서 실행.
   */
  if (
    isInsideInstance(root)
  ) {
    try {
      await normalizeSubtreeNames(
        root,
        root,
        stats
      );
    } catch (_) {}


    stats.preservedAreas++;
    stats.finalLayers =
      childrenOf(root)
        .length;


    return {
      success: true,
      root,
      stats
    };
  }


  /*
   * Root 자체 Auto Layout도 그대로 유지.
   */
  await cleanRoot(
    root,
    stats
  );


  /*
   * 안전한 경우에만 정렬.
   */
  sortLayersSafely(
    root
  );


  stats.finalLayers =
    childrenOf(root)
      .length;


  return {
    success: true,
    root,
    stats
  };
}


/* =========================================================
   UI MESSAGE HANDLER
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
     SELECT GARBAGE LAYER
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
     CURRENT SELECTION
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

          /*
           * 제1법칙 때문에
           * 무조건 Frame 변환하지 않음.
           */
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
        msg.garbageIds || []
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


    const resultRoots =
      [];


    const total = {
      screens:
        selection.length,

      /*
       * 기존 UI에서 PASS / FAIL을 판단하므로 유지.
       *
       * Preserve가 있어도 정상 처리 = committed.
       */
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
            resultRoots.push(
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

        } catch (screenError) {
          /*
           * 한 Screen 오류 때문에
           * 전체 Plugin 중단하지 않음.
           */
          console.warn(
            "Screen cleanup preserved:",
            safeName(
              originalRoot
            ),
            screenError
          );


          if (
            isAlive(
              originalRoot
            )
          ) {
            resultRoots.push(
              originalRoot
            );
          }


          /*
           * 화면이 그대로 남아있다면
           * 이것도 Rollback 실패가 아니라
           * Preserve 처리로 간주.
           */
          total.committed++;
          total.preservedAreas++;
        }
      }


      const aliveRoots =
        resultRoots.filter(
          root =>
            isAlive(root)
        );


      if (
        aliveRoots.length > 0
      ) {
        figma.currentPage.selection =
          aliveRoots;


        figma.viewport
          .scrollAndZoomIntoView(
            aliveRoots
          );
      }


      figma.ui.postMessage({
        type:
          "complete",

        result:
          total
      });


      if (
        total.preservedAreas > 0
      ) {
        figma.notify(
          `Cleanup 완료 · 화면 보호를 위해 ${total.preservedAreas}개 복잡 영역의 구조를 유지했습니다.`
        );

      } else {
        figma.notify(
          `Cleanup 완료 · Garbage ${total.removedGarbage}개 삭제`
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
