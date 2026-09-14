figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER
   VISUAL-FIRST + SMART FLATTEN
   =========================================================

   제1법칙
   ---------------------------------------------------------
   디자인 화면 구조/배치에 영향을 주지 않는다.

   처리 우선순위
   ---------------------------------------------------------
   1. 체크한 Garbage 실제 삭제
   2. LID 보호
   3. 안전한 Frame / Group 적극 Flatten
   4. 위험한 구조는 Preserve
   5. Instance는 안전하게 Detach 시도
   6. Layer Naming
   7. 안전한 경우 위치순 정렬

   중요한 변경
   ---------------------------------------------------------
   - 자식을 무조건 Root까지 올리지 않음
   - Container를 "한 단계씩" Flatten
   - Auto Layout 경계에서는 멈춤
   - Hidden Garbage는 체크했다면 실제 삭제
========================================================= */


/* =========================================================
   GLOBAL
========================================================= */

let renameTextToHyphen = false;
let convertFontToInter = false;

let approvedGarbageIds = new Set();

const ROW_TOLERANCE = 8;
const MAX_FLATTEN_PASSES = 30;


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


function hasChildren(node) {
  return childrenOf(node).length > 0;
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
      "Remove failed:",
      safeName(node),
      error
    );

    return false;
  }
}


/* =========================================================
   NODE TYPE
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
      node.layoutPositioning === "ABSOLUTE"
    ) {
      return false;
    }
  } catch (_) {}

  return true;
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
    safeAbsoluteTransform(parent);

  if (!parentTransform) {
    throw new Error(
      "Parent transform unavailable."
    );
  }

  return multiplyTransform(
    invertTransform(parentTransform),
    absoluteTransform
  );
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
    value.startsWith("cci_ctn_") ||
    value.startsWith("cci_msg_") ||
    value.startsWith("ctn_") ||
    value.startsWith("msg_")
  );
}


/* =========================================================
   GARBAGE
========================================================= */

function getGarbageReason(node) {
  if (!isAlive(node)) {
    return null;
  }


  /*
   * 명시적 Hidden.
   */
  try {
    if (
      "visible" in node &&
      node.visible === false
    ) {
      return "Hidden · visible=false";
    }
  } catch (_) {}


  /*
   * Opacity 0.
   */
  try {
    if (
      "opacity" in node &&
      node.opacity === 0
    ) {
      return "Transparent · opacity=0";
    }
  } catch (_) {}


  /*
   * Slice.
   */
  if (
    safeType(node) === "SLICE"
  ) {
    return "Slice Layer";
  }


  /*
   * 완전히 렌더 영역이 없는 Container.
   */
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
      return "No Rendered Content";
    }
  }


  return null;
}


function isSelectedGarbage(node) {
  const id =
    safeId(node);

  return (
    !!id &&
    approvedGarbageIds.has(id)
  );
}


/*
 * 부모 자체가 선택된 Garbage인지 확인.
 *
 * 부모가 삭제되면 자식까지 자동으로 삭제되므로
 * 중복 remove() 방지.
 */
function hasSelectedGarbageAncestor(node) {
  let current =
    safeParent(node);

  while (current) {
    const id =
      safeId(current);

    if (
      id &&
      approvedGarbageIds.has(id) &&
      getGarbageReason(current)
    ) {
      return true;
    }

    current =
      safeParent(current);
  }

  return false;
}


/*
 * 제1법칙과 Garbage 삭제를 같이 만족.
 *
 * visible=false
 * → Figma 화면 렌더에서 이미 제외된 상태
 * → 체크했다면 삭제 허용.
 *
 * opacity=0
 * → Auto Layout 공간을 차지할 수 있으므로
 *   Layout 참여 중이면 보호.
 */
function canDeleteGarbageSafely(node) {
  if (!isAlive(node)) {
    return false;
  }


  /*
   * Hidden은 삭제.
   */
  try {
    if (
      "visible" in node &&
      node.visible === false
    ) {
      return true;
    }
  } catch (_) {}


  /*
   * Slice.
   */
  if (
    safeType(node) === "SLICE"
  ) {
    return true;
  }


  /*
   * Render 자체가 없는 Container.
   */
  const reason =
    getGarbageReason(node);

  if (
    reason === "No Rendered Content"
  ) {
    if (
      participatesInAutoLayout(node)
    ) {
      return false;
    }

    return true;
  }


  /*
   * Opacity 0.
   */
  try {
    if (
      "opacity" in node &&
      node.opacity === 0
    ) {
      /*
       * Auto Layout item이면
       * 삭제 시 주변 요소가 이동할 수 있음.
       */
      if (
        participatesInAutoLayout(node)
      ) {
        return false;
      }

      return true;
    }
  } catch (_) {}


  return false;
}


/*
 * 선택된 Garbage 실제 삭제.
 *
 * 구조 변경 작업보다 먼저 실행한다.
 * → Instance Detach 등으로 ID가 바뀌기 전에 삭제.
 */
function deleteSelectedGarbage(
  root,
  stats
) {
  function walk(node) {
    if (!isAlive(node)) {
      return;
    }


    /*
     * Root 자체는 삭제하지 않음.
     */
    if (
      node !== root &&
      isSelectedGarbage(node) &&
      getGarbageReason(node)
    ) {
      /*
       * 부모가 이미 삭제 대상이면
       * 자식은 따로 처리하지 않음.
       */
      if (
        hasSelectedGarbageAncestor(node)
      ) {
        return;
      }


      if (
        canDeleteGarbageSafely(node)
      ) {
        if (
          safeRemove(node)
        ) {
          stats.removedGarbage++;
          return;
        }
      }


      stats.protectedGarbage++;
    }


    /*
     * Node가 살아있을 때만 Child 순회.
     */
    if (!isAlive(node)) {
      return;
    }


    for (
      const child of
      childrenOf(node)
    ) {
      walk(child);
    }
  }


  walk(root);
}


/* =========================================================
   PAINT / VISUAL SAFETY
========================================================= */

function hasVisiblePaint(paints) {
  if (!Array.isArray(paints)) {
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
  if (!isAlive(node)) {
    return false;
  }


  try {
    if (
      "fills" in node &&
      node.fills !== figma.mixed &&
      hasVisiblePaint(node.fills)
    ) {
      return true;
    }
  } catch (_) {}


  try {
    if (
      "strokes" in node &&
      node.strokes !== figma.mixed &&
      hasVisiblePaint(node.strokes)
    ) {
      return true;
    }
  } catch (_) {}


  return false;
}


function hasImageFill(node) {
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


function hasVisibleEffects(node) {
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


function hasRotation(node) {
  try {
    return (
      "rotation" in node &&
      typeof node.rotation === "number" &&
      Math.abs(node.rotation) > 0.001
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


  const parentBounds =
    safeBounds(node);


  if (!parentBounds) {
    return true;
  }


  const left =
    parentBounds.x;

  const top =
    parentBounds.y;

  const right =
    parentBounds.x +
    parentBounds.width;

  const bottom =
    parentBounds.y +
    parentBounds.height;


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


    const bounds =
      safeRenderBounds(child);


    if (!bounds) {
      continue;
    }


    if (
      bounds.x < left - 0.5 ||
      bounds.y < top - 0.5 ||
      bounds.x +
        bounds.width >
        right + 0.5 ||
      bounds.y +
        bounds.height >
        bottom + 0.5
    ) {
      return true;
    }
  }


  return false;
}


/* =========================================================
   FONT
========================================================= */

const loadedFonts =
  new Set();


async function loadFontOnce(fontName) {
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

  } catch (_) {
    return false;
  }
}


async function ensureTextFontsLoaded(node) {
  if (
    safeType(node) !== "TEXT"
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
        segment.fontName === figma.mixed
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
      node.fontName !== figma.mixed
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


function mapFontStyleToInter(styleName) {
  const value =
    String(styleName || "")
      .toLowerCase()
      .replace(/[_-]/g, " ");


  const italic =
    value.includes("italic") ||
    value.includes("oblique");


  let weight =
    "Regular";


  if (
    value.includes("black") ||
    value.includes("heavy")
  ) {
    weight = "Black";

  } else if (
    value.includes("extra bold") ||
    value.includes("extrabold")
  ) {
    weight = "Extra Bold";

  } else if (
    value.includes("semi bold") ||
    value.includes("semibold")
  ) {
    weight = "Semi Bold";

  } else if (
    value.includes("bold")
  ) {
    weight = "Bold";

  } else if (
    value.includes("medium")
  ) {
    weight = "Medium";

  } else if (
    value.includes("extra light") ||
    value.includes("extralight")
  ) {
    weight = "Extra Light";

  } else if (
    value.includes("light")
  ) {
    weight = "Light";

  } else if (
    value.includes("thin")
  ) {
    weight = "Thin";
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


async function loadInterStyle(style) {
  if (
    loadedInterStyles.has(style)
  ) {
    return style;
  }


  try {
    await figma.loadFontAsync({
      family:
        "Inter",

      style
    });

    loadedInterStyles.add(style);

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


async function convertTextToInter(node) {
  if (
    safeType(node) !== "TEXT"
  ) {
    return 0;
  }


  if (
    !await ensureTextFontsLoaded(node)
  ) {
    return 0;
  }


  try {
    const segments =
      node.getStyledTextSegments(
        ["fontName"]
      );


    let count = 0;


    for (
      const segment of segments
    ) {
      const oldStyle =
        segment.fontName &&
        segment.fontName !== figma.mixed
          ? segment.fontName.style
          : "Regular";


      const target =
        await loadInterStyle(
          mapFontStyleToInter(
            oldStyle
          )
        );


      if (!target) {
        continue;
      }


      node.setRangeFontName(
        segment.start,
        segment.end,
        {
          family:
            "Inter",

          style:
            target
        }
      );


      count++;
    }


    return count;

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
    safeType(node) !== "RECTANGLE" ||
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
      node.width / root.width >= 0.7 &&
      node.height / root.height >= 0.5
    );

  } catch (_) {
    return false;
  }
}


function looksLikeIPhoneFrame(node) {
  if (
    safeType(node) !== "FRAME"
  ) {
    return false;
  }


  const value =
    safeName(node)
      .toLowerCase();


  return (
    value.includes("iphone") ||
    value.includes("i phone")
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


  /* Text */

  if (
    type === "TEXT"
  ) {
    /*
     * LID 유지.
     */
    if (
      isLidName(originalName)
    ) {
      return;
    }


    if (
      renameTextToHyphen
    ) {
      try {
        node.name = "-";
      } catch (_) {}
    }


    return;
  }


  /* Line */

  if (
    type === "LINE"
  ) {
    try {
      node.name = "line";
    } catch (_) {}

    return;
  }


  /* Icon */

  if (
    looksLikeIcon(node)
  ) {
    try {
      node.name = "icon";
    } catch (_) {}

    return;
  }


  /* Rectangle */

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


  /* Ellipse */

  if (
    type === "ELLIPSE"
  ) {
    try {
      node.name = "shape";
    } catch (_) {}

    return;
  }


  /* Group */

  if (
    type === "GROUP"
  ) {
    try {
      node.name = "group";
    } catch (_) {}

    return;
  }


  /* Frame */

  if (
    type === "FRAME"
  ) {
    try {
      node.name =
        looksLikeIPhoneFrame(node)
          ? "iphone"
          : "frame";

    } catch (_) {}

    return;
  }


  /* Component */

  if (
    type === "COMPONENT"
  ) {
    try {
      node.name =
        "component";
    } catch (_) {}

    return;
  }


  /* Instance */

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
   SAFE CONTAINER CHECK
========================================================= */

/*
 * Container 자체가 구조용 껍데기인지 판단.
 *
 * 여기서 TRUE면 Flatten 적극 시도.
 */
function canFlattenContainerSafely(node) {
  if (!isContainer(node)) {
    return false;
  }


  /*
   * Instance는 먼저 Detach.
   */
  if (
    safeType(node) === "INSTANCE"
  ) {
    return false;
  }


  /*
   * 이 Container 자체가 Auto Layout이면
   * 자식 위치가 Layout에 의존하므로
   * 일단 Preserve.
   */
  if (
    isAutoLayout(node)
  ) {
    return false;
  }


  /*
   * 이 Container가 부모 Auto Layout의
   * Flow item이면 제거 시 Parent Layout이 바뀐다.
   */
  if (
    participatesInAutoLayout(node)
  ) {
    return false;
  }


  /*
   * Fill/Stroke가 있는 Container 제거는
   * Visual을 잃을 수 있음.
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
      node.blendMode !== "PASS_THROUGH" &&
      node.blendMode !== "NORMAL"
    ) {
      return false;
    }
  } catch (_) {}


  return true;
}


/* =========================================================
   INSTANCE DETACH
========================================================= */

function tryDetachInstance(
  node,
  stats
) {
  if (
    safeType(node) !== "INSTANCE"
  ) {
    return node;
  }


  /*
   * Hidden Garbage였다면
   * Garbage 단계에서 이미 삭제됐어야 함.
   */


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
      safeName(node),
      error
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
    safeType(node) !== "TEXT"
  ) {
    return;
  }


  if (
    convertFontToInter
  ) {
    const converted =
      await convertTextToInter(node);


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
   LOCAL ONE-LEVEL FLATTEN
========================================================= */

/*
 * 핵심 변경.
 *
 * Child를 Root까지 한 번에 올리지 않는다.
 *
 * Container의 바로 Parent로만 이동한다.
 *
 * before:
 *
 * Parent
 * └ Container
 *    ├ A
 *    └ B
 *
 * after:
 *
 * Parent
 * ├ A
 * └ B
 *
 * 다음 Pass에서 Parent도 안전하면
 * 다시 한 단계 벗긴다.
 */
async function flattenContainerOneLevel(
  container,
  root,
  stats
) {
  if (
    !isAlive(container)
  ) {
    return false;
  }


  if (
    !canFlattenContainerSafely(
      container
    )
  ) {
    return false;
  }


  const parent =
    safeParent(container);


  if (
    !parent ||
    !("children" in parent)
  ) {
    return false;
  }


  /*
   * Parent가 Auto Layout이면
   * Container 제거 자체가 Parent Layout을 바꿀 수 있음.
   */
  if (
    isAutoLayout(parent)
  ) {
    return false;
  }


  let containerIndex = -1;


  try {
    containerIndex =
      parent.children.indexOf(
        container
      );
  } catch (_) {
    return false;
  }


  if (
    containerIndex < 0
  ) {
    return false;
  }


  const children =
    childrenOf(container);


  /*
   * 빈 구조용 Container.
   */
  if (
    children.length === 0
  ) {
    if (
      safeRemove(container)
    ) {
      stats.removedContainers++;

      return true;
    }

    return false;
  }


  /*
   * Child의 현재 Absolute Transform 저장.
   */
  const snapshots = [];


  for (
    const child of children
  ) {
    if (!isAlive(child)) {
      continue;
    }


    const transform =
      safeAbsoluteTransform(child);


    if (!transform) {
      return false;
    }


    /*
     * Text 이동 가능 여부 선검사.
     */
    if (
      safeType(child) === "TEXT"
    ) {
      if (
        !await ensureTextFontsLoaded(
          child
        )
      ) {
        return false;
      }
    }


    snapshots.push({
      child,
      transform
    });
  }


  /*
   * 모두 선검사 통과 후 실제 이동.
   *
   * 원래 Container 위치에 Child들을 삽입한다.
   */
  let insertionIndex =
    containerIndex;


  try {
    for (
      const item of snapshots
    ) {
      const child =
        item.child;


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

      stats.movedLayers++;
    }


    /*
     * Container가 비었을 때만 삭제.
     */
    if (
      childrenOf(container)
        .length === 0
    ) {
      if (
        safeRemove(container)
      ) {
        stats.removedContainers++;
      }


      return true;
    }


    return false;

  } catch (error) {
    /*
     * 여기서 일부 이동이 완료된 뒤 에러가 나면
     * 롤백하기 어렵기 때문에,
     * 애초에 매우 안전한 Container만 여기 들어온다.
     */
    console.warn(
      "Flatten one-level stopped:",
      safeName(container),
      error
    );


    return false;
  }
}


/* =========================================================
   INSTANCE PASS
========================================================= */

/*
 * Garbage 삭제 후 Instance Detach.
 *
 * Auto Layout 안의 Instance라도
 * Detach 자체는 현재 렌더와 위치를 유지하므로 시도.
 */
function detachInstancesPass(
  root,
  stats
) {
  let changed =
    false;


  function walk(node) {
    if (!isAlive(node)) {
      return;
    }


    const children =
      childrenOf(node);


    for (
      const original of children
    ) {
      if (!isAlive(original)) {
        continue;
      }


      let child =
        original;


      if (
        safeType(child) ===
        "INSTANCE"
      ) {
        const detached =
          tryDetachInstance(
            child,
            stats
          );


        if (
          detached !== child
        ) {
          child =
            detached;

          changed =
            true;
        }
      }


      /*
       * Detach 실패 Instance 내부는
       * 수정하지 않는다.
       */
      if (
        safeType(child) ===
        "INSTANCE"
      ) {
        continue;
      }


      walk(child);
    }
  }


  walk(root);


  return changed;
}


/* =========================================================
   FLATTEN PASS
========================================================= */

async function flattenPass(
  root,
  stats
) {
  let changed =
    false;


  /*
   * 가장 깊은 Container부터 처리.
   */
  const targets = [];


  function collect(
    node,
    depth
  ) {
    if (!isAlive(node)) {
      return;
    }


    for (
      const child of
      childrenOf(node)
    ) {
      collect(
        child,
        depth + 1
      );
    }


    if (
      node !== root &&
      isContainer(node)
    ) {
      targets.push({
        node,
        depth
      });
    }
  }


  collect(
    root,
    0
  );


  targets.sort(
    (a, b) =>
      b.depth -
      a.depth
  );


  for (
    const item of targets
  ) {
    const node =
      item.node;


    if (!isAlive(node)) {
      continue;
    }


    /*
     * Instance가 아직 남아있으면 Preserve.
     */
    if (
      safeType(node) ===
      "INSTANCE"
    ) {
      continue;
    }


    if (
      !canFlattenContainerSafely(
        node
      )
    ) {
      continue;
    }


    const flattened =
      await flattenContainerOneLevel(
        node,
        root,
        stats
      );


    if (flattened) {
      changed = true;
    }
  }


  return changed;
}


/* =========================================================
   MULTI PASS FLATTEN
========================================================= */

async function flattenSafely(
  root,
  stats
) {
  for (
    let pass = 0;
    pass < MAX_FLATTEN_PASSES;
    pass++
  ) {
    const changed =
      await flattenPass(
        root,
        stats
      );


    if (!changed) {
      break;
    }
  }
}


/* =========================================================
   NAME + FONT PASS
========================================================= */

async function normalizeSubtree(
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


  /*
   * Instance 내부는 이름 수정 제한이 있을 수 있지만
   * try/catch 기반이라 실패하면 넘어감.
   */
  for (
    const child of
    childrenOf(node)
  ) {
    await normalizeSubtree(
      child,
      root,
      stats
    );
  }
}


/* =========================================================
   PRESERVED COUNT
========================================================= */

function countPreservedContainers(
  root
) {
  let count = 0;


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
   ORDERING
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
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
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
   * 같은 줄 → 좌 → 우
   */
  if (
    Math.abs(
      aCenterY -
      bCenterY
    ) <= ROW_TOLERANCE
  ) {
    const x =
      a.bounds.x -
      b.bounds.x;


    if (
      Math.abs(x) > 0.1
    ) {
      return x;
    }
  }


  /*
   * 위 → 아래
   */
  const y =
    a.bounds.y -
    b.bounds.y;


  if (
    Math.abs(y) > 0.1
  ) {
    return y;
  }


  return (
    a.originalPanelIndex -
    b.originalPanelIndex
  );
}


/*
 * 정렬은 Root 바로 아래에서만.
 *
 * Root가 Auto Layout이면 순서 변경이
 * 화면 위치 자체를 바꿀 수 있으므로 Skip.
 *
 * 겹치는 Layer는 기존 Z-order 관계 유지.
 */
function sortRootLayersSafely(root) {
  if (
    !isAlive(root) ||
    isAutoLayout(root)
  ) {
    return;
  }


  const children =
    childrenOf(root);


  if (
    children.length <= 1
  ) {
    return;
  }


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
   * 겹치는 Layer는 기존 Z-order 잠금.
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


  const available =
    items.filter(
      item =>
        item.indegree === 0
    );


  const desiredPanel =
    [];


  while (
    available.length > 0
  ) {
    available.sort(
      compareSpatial
    );


    const current =
      available.shift();


    desiredPanel.push(
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
    desiredPanel.length !==
    items.length
  ) {
    return;
  }


  /*
   * Layer Panel 위→아래의 반대가
   * 실제 children 순서.
   */
  const desiredChildren =
    desiredPanel
      .map(
        item => item.node
      )
      .reverse();


  for (
    let i = 0;
    i < desiredChildren.length;
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

    } catch (_) {
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


    const reason =
      getGarbageReason(node);


    if (reason) {
      result.garbage++;


      result.garbageItems.push({
        id:
          safeId(node) || "",

        name,

        type:
          safeType(node) ||
          "UNKNOWN",

        reason,

        path:
          currentPath
      });
    }


    if (
      node !== root &&
      isContainer(node)
    ) {
      result.containers++;


      /*
       * 기존 UI 필드명 유지.
       * 실제 의미 = Preserve 후보.
       */
      if (
        !canFlattenContainerSafely(
          node
        )
      ) {
        result.bakeCandidates++;
      }
    }


    if (
      safeType(node) === "INSTANCE"
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
        node.isMask
      ) {
        result.masks++;
      }
    } catch (_) {}


    if (
      node !== root &&
      actuallyClipsChildren(node)
    ) {
      result.clips++;
    }


    if (
      safeType(node) === "TEXT"
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
              segment.fontName === figma.mixed ||
              segment.fontName.family !== "Inter"
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
      safeType(node) === "LINE"
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

async function processRoot(root) {
  const stats =
    createStats();


  if (!isAlive(root)) {
    return {
      success: false,
      root,
      stats
    };
  }


  /* =====================================================
     1. GARBAGE FIRST
  ===================================================== */

  /*
   * ID가 바뀌기 전에 먼저 삭제.
   */
  deleteSelectedGarbage(
    root,
    stats
  );


  /* =====================================================
     2. ROOT INSTANCE
  ===================================================== */

  if (
    safeType(root) === "INSTANCE"
  ) {
    const detached =
      tryDetachInstance(
        root,
        stats
      );


    if (
      safeType(detached) === "INSTANCE"
    ) {
      /*
       * Root Instance detach 실패.
       * 구조 작업은 포기.
       */
      await normalizeSubtree(
        detached,
        detached,
        stats
      );


      stats.preservedAreas++;

      stats.finalLayers =
        childrenOf(detached)
          .length;


      return {
        success: true,
        root: detached,
        stats
      };
    }


    root =
      detached;
  }


  /* =====================================================
     3. INTERNAL INSTANCE DETACH
  ===================================================== */

  detachInstancesPass(
    root,
    stats
  );


  /* =====================================================
     4. SAFE MULTI-PASS FLATTEN
  ===================================================== */

  await flattenSafely(
    root,
    stats
  );


  /* =====================================================
     5. NAME + FONT
  ===================================================== */

  await normalizeSubtree(
    root,
    root,
    stats
  );


  /* =====================================================
     6. ORDER
  ===================================================== */

  sortRootLayersSafely(
    root
  );


  /* =====================================================
     7. RESULT
  ===================================================== */

  stats.preservedAreas =
    countPreservedContainers(
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
     SELECT LAYER
  ===================================================== */

  if (
    msg.type === "select-layer"
  ) {
    try {
      const node =
        await figma.getNodeByIdAsync(
          msg.nodeId
        );


      if (
        !node ||
        node.type === "DOCUMENT" ||
        node.type === "PAGE"
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
    msg.type === "analyze"
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

          ...analyzeScreen(root)
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
    msg.type === "clean"
  ) {
    /*
     * UI Garbage 체크박스.
     */
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
        const root of selection
      ) {
        try {
          const result =
            await processRoot(root);


          if (
            result.root &&
            isAlive(result.root)
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

        } catch (error) {
          console.warn(
            "Screen preserved after error:",
            safeName(root),
            error
          );


          if (
            isAlive(root)
          ) {
            resultRoots.push(root);
          }


          /*
           * 화면 보존 상태면 전체 실패로
           * 처리하지 않는다.
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
        total.protectedGarbage > 0
      ) {
        figma.notify(
          `Cleanup 완료 · Garbage ${total.removedGarbage}개 삭제 / 화면 보호로 ${total.protectedGarbage}개 유지`
        );

      } else if (
        total.preservedAreas > 0
      ) {
        figma.notify(
          `Cleanup 완료 · Garbage ${total.removedGarbage}개 삭제 / 복잡 Container ${total.preservedAreas}개 유지`
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
