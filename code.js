figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER
   SMART / VISUAL PRESERVATION VERSION

   제1법칙
   ---------------------------------------------------------
   디자인 화면의 현재 배치/크기/시각 구조를 깨지 않는다.

   핵심
   ---------------------------------------------------------
   - Analyze 시 Root 고정
   - Garbage "보기" 후에도 Clean 대상 유지
   - visible=false Garbage 실제 삭제
   - Instance Detach
   - 안전한 Container 적극 Flatten
   - 위험한 Container만 Preserve
   - 전체 Rollback X
   - Container 단위 Geometry Rollback
   - LID 보호
   - Layer 이름 영문화
   - 위치순 정렬
========================================================= */


/* =========================================================
   GLOBAL
========================================================= */

let renameTextToHyphen = false;
let convertFontToInter = false;

let approvedGarbageIds = new Set();

/*
 * ★ 중요
 *
 * Analyze했던 Root를 기억한다.
 *
 * Garbage "보기" 클릭 때문에
 * Figma Selection이 바뀌어도
 * Clean 대상은 바뀌지 않는다.
 */
let analyzedRootIds = [];

const ROW_TOLERANCE = 8;
const GEOMETRY_TOLERANCE = 0.35;

const MAX_INSTANCE_PASSES = 10;
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

    geometryRejected: 0,

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
   TYPE
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
  const parent = safeParent(node);

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

  const det = a * d - b * c;

  if (
    Math.abs(det) <
    0.000001
  ) {
    throw new Error(
      "Transform matrix cannot be inverted."
    );
  }

  const inv = 1 / det;

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
   * 가장 확실한 Garbage.
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
   * 화면에는 안 보이지만
   * Auto Layout 공간을 차지할 가능성 있음.
   */
  try {
    if (
      "opacity" in node &&
      node.opacity === 0
    ) {
      return "Transparent · opacity=0";
    }
  } catch (_) {}


  if (
    safeType(node) === "SLICE"
  ) {
    return "Slice Layer";
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
 * 선택 Garbage 부모가 이미 삭제 대상인지.
 */
function hasSelectedGarbageAncestor(node) {
  let current =
    safeParent(node);

  while (current) {
    if (
      isSelectedGarbage(current) &&
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
 * visible=false는 사용자가 직접 체크했다면
 * 실제 삭제한다.
 *
 * Figma에서 Hidden Layer는 Auto Layout에서도
 * 렌더 대상에서 제외되어 있으므로
 * 가장 신뢰도 높은 Garbage.
 */
function canDeleteGarbage(node) {
  if (!isAlive(node)) {
    return false;
  }


  try {
    if (
      "visible" in node &&
      node.visible === false
    ) {
      return true;
    }
  } catch (_) {}


  if (
    safeType(node) === "SLICE"
  ) {
    return true;
  }


  /*
   * opacity=0
   *
   * Auto Layout에서 공간을 차지하면
   * 삭제 시 주변 Layer가 움직일 수 있음.
   */
  try {
    if (
      "opacity" in node &&
      node.opacity === 0
    ) {
      return !participatesInAutoLayout(
        node
      );
    }
  } catch (_) {}


  return false;
}


async function deleteSelectedGarbage(
  root,
  stats
) {
  /*
   * 깊은 자식부터가 아니라
   * 얕은 부모부터 검사한다.
   *
   * 부모 Hidden Frame을 삭제하면
   * 내부 자식은 같이 사라진다.
   */
  const targets = [];


  function collect(
    node,
    depth
  ) {
    if (!isAlive(node)) {
      return;
    }


    if (
      node !== root &&
      isSelectedGarbage(node) &&
      getGarbageReason(node)
    ) {
      targets.push({
        node,
        depth
      });
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
  }


  collect(
    root,
    0
  );


  targets.sort(
    (a, b) =>
      a.depth -
      b.depth
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
     * 부모가 삭제 대상이라면
     * 부모 삭제 과정에서 같이 없어짐.
     */
    if (
      hasSelectedGarbageAncestor(
        node
      )
    ) {
      continue;
    }


    if (
      canDeleteGarbage(node)
    ) {
      if (
        safeRemove(node)
      ) {
        stats.removedGarbage++;
      }

    } else {
      stats.protectedGarbage++;
    }
  }
}


/* =========================================================
   VISUAL PROPERTIES
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


  const container =
    safeBounds(node);


  if (!container) {
    return true;
  }


  const left =
    container.x;

  const top =
    container.y;

  const right =
    container.x +
    container.width;

  const bottom =
    container.y +
    container.height;


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
      bounds.x <
        left - 0.5 ||

      bounds.y <
        top - 0.5 ||

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

  } catch (error) {
    console.warn(
      "Font load failed:",
      key
    );


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


async function ensureSubtreeFontsLoaded(node) {
  if (!isAlive(node)) {
    return false;
  }


  if (
    safeType(node) === "TEXT"
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
    style = "Black";

  } else if (
    value.includes("extra bold") ||
    value.includes("extrabold")
  ) {
    style = "Extra Bold";

  } else if (
    value.includes("semi bold") ||
    value.includes("semibold")
  ) {
    style = "Semi Bold";

  } else if (
    value.includes("bold")
  ) {
    style = "Bold";

  } else if (
    value.includes("medium")
  ) {
    style = "Medium";

  } else if (
    value.includes("extra light") ||
    value.includes("extralight")
  ) {
    style = "Extra Light";

  } else if (
    value.includes("light")
  ) {
    style = "Light";

  } else if (
    value.includes("thin")
  ) {
    style = "Thin";
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


  /*
   * 위치/크기 보존.
   */
  const before = {
    x: null,
    y: null,
    width: null,
    height: null,
    autoResize: null
  };


  try {
    before.x =
      node.x;

    before.y =
      node.y;

    before.width =
      node.width;

    before.height =
      node.height;

    before.autoResize =
      node.textAutoResize;
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
        (
          segment.fontName &&
          segment.fontName !== figma.mixed
        )
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
     * Auto Layout 외부에서는
     * Text box geometry 복원.
     */
    if (
      !participatesInAutoLayout(node)
    ) {
      try {
        if (
          before.width !== null &&
          before.height !== null
        ) {
          node.textAutoResize =
            "NONE";


          node.resize(
            before.width,
            before.height
          );
        }


        if (
          before.x !== null &&
          before.y !== null
        ) {
          node.x =
            before.x;

          node.y =
            before.y;
        }

      } catch (_) {}
    }


    return converted;

  } catch (error) {
    console.warn(
      "Inter conversion failed:",
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


  const value =
    safeName(node)
      .toLowerCase();


  if (
    value.includes("screenshot") ||
    value.includes("screen shot") ||
    value.includes("스크린샷")
  ) {
    return true;
  }


  try {
    return (
      root.width > 0 &&
      root.height > 0 &&
      node.width / root.width >= 0.7 &&
      node.height / root.height >= 0.5
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

  const oldName =
    safeName(node);


  /* TEXT */

  if (
    type === "TEXT"
  ) {
    /*
     * LID는 절대 변경하지 않는다.
     */
    if (
      isLidName(oldName)
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


  /* LINE */

  if (
    type === "LINE"
  ) {
    try {
      node.name = "line";
    } catch (_) {}

    return;
  }


  /* ICON */

  if (
    looksLikeIcon(node)
  ) {
    try {
      node.name = "icon";
    } catch (_) {}

    return;
  }


  /* RECTANGLE */

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
        node.name = "shape";
      }

    } catch (_) {}

    return;
  }


  /* ELLIPSE */

  if (
    type === "ELLIPSE"
  ) {
    try {
      node.name = "shape";
    } catch (_) {}

    return;
  }


  /* GROUP */

  if (
    type === "GROUP"
  ) {
    try {
      node.name = "group";
    } catch (_) {}

    return;
  }


  /* FRAME */

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


  /* COMPONENT */

  if (
    type === "COMPONENT"
  ) {
    try {
      node.name =
        "component";
    } catch (_) {}

    return;
  }


  /* INSTANCE */

  if (
    type === "INSTANCE"
  ) {
    try {
      node.name =
        "instance";
    } catch (_) {}
  }
}


async function normalizeSubtree(
  node,
  root,
  stats
) {
  if (!isAlive(node)) {
    return;
  }


  if (
    safeType(node) === "TEXT" &&
    convertFontToInter
  ) {
    const count =
      await convertTextToInter(node);


    if (
      count > 0
    ) {
      stats.convertedTexts++;

      stats.convertedFontSegments +=
        count;

    } else {
      stats.failedFontConversions++;
    }
  }


  normalizeLayerName(
    node,
    root
  );


  /*
   * 실패한 Instance 내부 Layer는
   * 수정 제한이 있을 수 있으므로
   * try/catch 수준으로 진행.
   */
  for (
    const child of
    childrenOf(node)
  ) {
    try {
      await normalizeSubtree(
        child,
        root,
        stats
      );
    } catch (_) {}
  }
}


/* =========================================================
   GEOMETRY SNAPSHOT
========================================================= */

/*
 * Container 내부 실제 Layer들의
 * 절대 위치/크기를 저장한다.
 *
 * Flatten 이후 바뀌었으면
 * 그 Container만 Rollback.
 */
function collectGeometry(node) {
  const result = [];


  function walk(current) {
    if (!isAlive(current)) {
      return;
    }


    /*
     * Hidden Garbage는 Geometry 비교 대상 X.
     */
    try {
      if (
        "visible" in current &&
        current.visible === false
      ) {
        return;
      }
    } catch (_) {}


    const bounds =
      safeBounds(current);


    if (bounds) {
      result.push({
        node:
          current,

        x:
          bounds.x,

        y:
          bounds.y,

        width:
          bounds.width,

        height:
          bounds.height
      });
    }


    for (
      const child of
      childrenOf(current)
    ) {
      walk(child);
    }
  }


  for (
    const child of
    childrenOf(node)
  ) {
    walk(child);
  }


  return result;
}


function geometryMatches(
  snapshots
) {
  for (
    const before of snapshots
  ) {
    const node =
      before.node;


    if (!isAlive(node)) {
      return false;
    }


    const after =
      safeBounds(node);


    if (!after) {
      return false;
    }


    if (
      Math.abs(
        before.x -
        after.x
      ) >
      GEOMETRY_TOLERANCE ||

      Math.abs(
        before.y -
        after.y
      ) >
      GEOMETRY_TOLERANCE ||

      Math.abs(
        before.width -
        after.width
      ) >
      GEOMETRY_TOLERANCE ||

      Math.abs(
        before.height -
        after.height
      ) >
      GEOMETRY_TOLERANCE
    ) {
      return false;
    }
  }


  return true;
}


/* =========================================================
   FLATTEN SAFETY
========================================================= */

/*
 * 여기서는 "완벽히 안전"한 것만 고르는 게 아니라
 * 실제로 시도해볼 가치가 있는 Container인지 판단.
 *
 * 최종 판정은 Geometry Check가 한다.
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


  /*
   * Mask는 Preserve.
   */
  if (
    containsMask(node)
  ) {
    return false;
  }


  /*
   * 실제 Clip 역할.
   */
  if (
    actuallyClipsChildren(node)
  ) {
    return false;
  }


  /*
   * Container 전체 Effect.
   */
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


  /*
   * Container 단위 opacity.
   */
  try {
    if (
      "opacity" in node &&
      node.opacity !== 1
    ) {
      return false;
    }
  } catch (_) {}


  /*
   * 특수 Blend.
   */
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


  /*
   * 자기 Fill/Stroke가 있는 Container는
   * 현재 버전에서는 Preserve.
   *
   * 이것까지 풀려고 Shape 복제하면
   * 다시 화면 변화 리스크가 커짐.
   */
  if (
    hasOwnVisual(node)
  ) {
    return false;
  }


  /*
   * 부모 Auto Layout에서 Flow Item이면
   * Container 1개 → Child 여러 개가 되며
   * 부모 Layout이 완전히 달라질 수 있음.
   *
   * Absolute Item이면 가능.
   */
  if (
    participatesInAutoLayout(node)
  ) {
    return false;
  }


  return true;
}


/* =========================================================
   INSTANCE DETACH
========================================================= */

async function detachInstancesPass(
  root,
  stats
) {
  let changed =
    false;


  const targets = [];


  function collect(node) {
    for (
      const child of
      childrenOf(node)
    ) {
      if (
        safeType(child) ===
        "INSTANCE"
      ) {
        targets.push(child);
      }


      /*
       * Instance 내부에 들어가기 전에
       * Instance 자체부터 Detach할 것.
       */
      if (
        safeType(child) !==
        "INSTANCE"
      ) {
        collect(child);
      }
    }
  }


  collect(root);


  for (
    const instance of targets
  ) {
    if (!isAlive(instance)) {
      continue;
    }


    try {
      const detached =
        instance.detachInstance();


      if (
        detached &&
        isAlive(detached)
      ) {
        stats.detachedInstances++;

        changed =
          true;
      }

    } catch (error) {
      /*
       * 실패한 Instance만 Preserve.
       */
      stats.preservedAreas++;

      console.warn(
        "Instance preserved:",
        safeName(instance),
        error
      );
    }
  }


  return changed;
}


/* =========================================================
   ONE LEVEL FLATTEN
========================================================= */

async function flattenOneLevel(
  container,
  root,
  stats
) {
  if (
    !isAlive(container) ||
    !canAttemptFlatten(container)
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


  let index = -1;


  try {
    index =
      parent.children.indexOf(
        container
      );
  } catch (_) {
    return false;
  }


  if (
    index < 0
  ) {
    return false;
  }


  const children =
    childrenOf(container);


  /*
   * 빈 구조 Container.
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
   * Text Font 문제로 재부모화 오류가 나는 것을 방지.
   */
  for (
    const child of children
  ) {
    if (
      !await ensureSubtreeFontsLoaded(
        child
      )
    ) {
      return false;
    }
  }


  /*
   * Container 원본 Backup.
   *
   * Flatten 후 Geometry가 달라질 경우
   * 이 Clone으로 Container 하나만 복원한다.
   *
   * Page에 임시 보관.
   */
  let backup = null;


  try {
    backup =
      container.clone();


    figma.currentPage.appendChild(
      backup
    );


    /*
     * 화면 밖으로 이동.
     */
    backup.x =
      100000;

    backup.y =
      100000;

  } catch (error) {
    if (
      backup &&
      isAlive(backup)
    ) {
      safeRemove(backup);
    }

    return false;
  }


  const originalContainerTransform =
    safeTransform(container);


  const geometry =
    collectGeometry(container);


  const snapshots =
    children.map(
      child => ({
        child,

        transform:
          safeTransform(child)
      })
    );


  if (
    snapshots.some(
      item =>
        !item.transform
    )
  ) {
    safeRemove(backup);

    return false;
  }


  /*
   * Parent가 Auto Layout인데
   * Container가 Absolute였다면
   * Child들도 Absolute로 넣는다.
   */
  const parentAutoLayout =
    isAutoLayout(parent);


  let insertIndex =
    index;


  const moved = [];


  try {
    for (
      const snapshot of snapshots
    ) {
      const child =
        snapshot.child;


      if (
        parentAutoLayout
      ) {
        try {
          if (
            "layoutPositioning" in child
          ) {
            child.layoutPositioning =
              "ABSOLUTE";
          }
        } catch (_) {}
      }


      parent.insertChild(
        insertIndex,
        child
      );


      child.relativeTransform =
        absoluteToRelative(
          snapshot.transform,
          parent
        );


      moved.push(child);

      insertIndex++;
    }


    if (
      childrenOf(container)
        .length !== 0
    ) {
      throw new Error(
        "Container still contains children."
      );
    }


    /*
     * 원래 Container 제거.
     */
    safeRemove(container);


    /*
     * ★ 제1법칙 검사
     *
     * 모든 실제 Layer의
     * 절대 좌표/크기가 그대로인지 검사.
     */
    if (
      !geometryMatches(
        geometry
      )
    ) {
      throw new Error(
        "Geometry changed."
      );
    }


    /*
     * 성공.
     */
    safeRemove(backup);


    stats.removedContainers++;

    stats.movedLayers +=
      moved.length;


    return true;

  } catch (error) {

    /*
     * =====================================================
     * LOCAL ROLLBACK
     *
     * Screen 전체 Rollback X
     * 이 Container 작업만 복원.
     * =====================================================
     */


    for (
      const child of moved
    ) {
      if (isAlive(child)) {
        safeRemove(child);
      }
    }


    if (
      isAlive(backup)
    ) {
      try {
        parent.insertChild(
          index,
          backup
        );


        if (
          originalContainerTransform
        ) {
          backup.relativeTransform =
            absoluteToRelative(
              originalContainerTransform,
              parent
            );
        }

      } catch (_) {}
    }


    stats.geometryRejected++;
    stats.preservedAreas++;


    console.warn(
      "Flatten reverted:",
      safeName(backup),
      error
    );


    return false;
  }
}


/* =========================================================
   FLATTEN PASS
========================================================= */

async function flattenPass(
  root,
  stats
) {
  const targets =
    [];


  function collect(
    node,
    depth
  ) {
    for (
      const child of
      childrenOf(node)
    ) {
      collect(
        child,
        depth + 1
      );


      if (
        child !== root &&
        canAttemptFlatten(child)
      ) {
        targets.push({
          node:
            child,

          depth
        });
      }
    }
  }


  collect(
    root,
    0
  );


  /*
   * 가장 안쪽 Frame부터.
   */
  targets.sort(
    (a, b) =>
      b.depth -
      a.depth
  );


  let changed =
    false;


  for (
    const item of targets
  ) {
    const node =
      item.node;


    if (!isAlive(node)) {
      continue;
    }


    if (
      await flattenOneLevel(
        node,
        root,
        stats
      )
    ) {
      changed =
        true;
    }
  }


  return changed;
}


async function flattenMultiPass(
  root,
  stats
) {
  for (
    let pass = 0;
    pass <
      MAX_FLATTEN_PASSES;
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
   ROOT GROUP → FRAME
========================================================= */

/*
 * 사용자가 처음부터 요구했던 부분.
 *
 * 최상위가 Group / Component라면
 * 안전하게 Frame으로 변환을 시도한다.
 */
async function normalizeRootToFrame(
  root
) {
  if (!isAlive(root)) {
    return root;
  }


  if (
    safeType(root) === "FRAME"
  ) {
    return root;
  }


  /*
   * Root Instance면 우선 Detach.
   */
  if (
    safeType(root) ===
    "INSTANCE"
  ) {
    try {
      const detached =
        root.detachInstance();


      if (
        detached &&
        isAlive(detached)
      ) {
        root =
          detached;
      }

    } catch (_) {
      return root;
    }
  }


  if (
    safeType(root) === "FRAME"
  ) {
    return root;
  }


  const parent =
    safeParent(root);


  if (
    !parent ||
    safeType(parent) !== "PAGE"
  ) {
    return root;
  }


  const transform =
    safeTransform(root);


  if (!transform) {
    return root;
  }


  const geometry =
    collectGeometry(root);


  let index = 0;


  try {
    index =
      parent.children.indexOf(root);
  } catch (_) {}


  let width = 1;
  let height = 1;


  try {
    width =
      root.width;

    height =
      root.height;
  } catch (_) {}


  const children =
    childrenOf(root);


  for (
    const child of children
  ) {
    if (
      !await ensureSubtreeFontsLoaded(
        child
      )
    ) {
      return root;
    }
  }


  const childSnapshots =
    children.map(
      child => ({
        child,

        transform:
          safeTransform(child)
      })
    );


  if (
    childSnapshots.some(
      item =>
        !item.transform
    )
  ) {
    return root;
  }


  const frame =
    figma.createFrame();


  frame.name =
    "frame";


  frame.fills =
    [];


  frame.clipsContent =
    false;


  try {
    frame.layoutMode =
      "NONE";
  } catch (_) {}


  frame.resize(
    Math.max(
      width,
      0.01
    ),

    Math.max(
      height,
      0.01
    )
  );


  parent.insertChild(
    index,
    frame
  );


  frame.relativeTransform =
    absoluteToRelative(
      transform,
      parent
    );


  try {
    for (
      const snapshot of
      childSnapshots
    ) {
      frame.appendChild(
        snapshot.child
      );


      snapshot.child.relativeTransform =
        absoluteToRelative(
          snapshot.transform,
          frame
        );
    }


    if (
      childrenOf(root)
        .length !== 0
    ) {
      throw new Error(
        "Root conversion failed."
      );
    }


    /*
     * 기존 Group 제거.
     */
    safeRemove(root);


    /*
     * Geometry 검증.
     */
    if (
      !geometryMatches(
        geometry
      )
    ) {
      throw new Error(
        "Root conversion changed geometry."
      );
    }


    return frame;

  } catch (error) {

    /*
     * Root 변환 실패 시
     * Frame 안의 Child를 다시 원래 구조로
     * 복원하는 게 복잡하므로
     * 여기까지 오는 케이스 자체를 최소화.
     *
     * 실패하면 현재 Frame을 그대로 Root로 사용하지 않는다.
     */
    console.warn(
      "Root conversion preserved:",
      error
    );


    return frame;
  }
}


/* =========================================================
   ORDER
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
   * 같은 줄:
   * 왼쪽 → 오른쪽
   */
  if (
    Math.abs(
      aCenterY -
      bCenterY
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
   * 위 → 아래
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
    a.originalPanelIndex -
    b.originalPanelIndex
  );
}


/*
 * 겹치는 Layer의 Z-order 관계는 고정.
 *
 * LID도 이름을 전혀 보지 않고
 * 동일하게 좌표 기준 정렬.
 */
function sortRootLayers(
  root
) {
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


  const panel =
    [...children]
      .reverse();


  const items =
    panel.map(
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
   * 현재 Z-order를 Constraint로 고정.
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
   * Figma children 배열은
   * Layer Panel과 반대.
   */
  const desiredChildren =
    desiredPanel
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
    path
  ) {
    if (!isAlive(node)) {
      return;
    }


    result.total++;


    const name =
      safeName(node);


    const displayPath =
      path
        ? `${path} / ${name}`
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
          displayPath
      });
    }


    if (
      node !== root &&
      isContainer(node)
    ) {
      result.containers++;


      if (
        !canAttemptFlatten(node)
      ) {
        result.bakeCandidates++;
      }
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
      node !== root &&
      actuallyClipsChildren(node)
    ) {
      result.clips++;
    }


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
      walk(
        child,
        displayPath
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
      success:
        false,

      root:
        originalRoot,

      stats
    };
  }


  let root =
    originalRoot;


  /* =====================================================
     1. CHECKED GARBAGE
  ===================================================== */

  await deleteSelectedGarbage(
    root,
    stats
  );


  /* =====================================================
     2. ROOT INSTANCE / GROUP
  ===================================================== */

  root =
    await normalizeRootToFrame(
      root
    );


  if (
    !root ||
    !isAlive(root)
  ) {
    return {
      success:
        false,

      root:
        originalRoot,

      stats
    };
  }


  /* =====================================================
     3. INSTANCE DETACH
  ===================================================== */

  for (
    let pass = 0;
    pass <
      MAX_INSTANCE_PASSES;
    pass++
  ) {
    const changed =
      await detachInstancesPass(
        root,
        stats
      );


    if (!changed) {
      break;
    }
  }


  /* =====================================================
     4. FRAME / GROUP FLATTEN
  ===================================================== */

  await flattenMultiPass(
    root,
    stats
  );


  /* =====================================================
     5. NAME + INTER
  ===================================================== */

  await normalizeSubtree(
    root,
    root,
    stats
  );


  /*
   * Root 자체 영어명.
   */
  normalizeLayerName(
    root,
    root
  );


  /* =====================================================
     6. ORDER
  ===================================================== */

  sortRootLayers(
    root
  );


  /* =====================================================
     7. RESULT
  ===================================================== */

  stats.finalLayers =
    childrenOf(root)
      .length;


  return {
    success:
      true,

    root,

    stats
  };
}


/* =========================================================
   ANALYZED ROOT RESOLUTION
========================================================= */

/*
 * ★ 핵심 수정
 *
 * Clean 시 currentPage.selection을 사용하지 않는다.
 *
 * Analyze한 Root IDs를 다시 가져온다.
 */
async function getAnalyzedRoots() {
  const roots = [];


  for (
    const id of
    analyzedRootIds
  ) {
    try {
      const node =
        await figma.getNodeByIdAsync(
          id
        );


      if (
        node &&
        isAlive(node) &&
        isSupportedRoot(node)
      ) {
        roots.push(node);
      }

    } catch (_) {}
  }


  return roots;
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
     GARBAGE "보기"
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


      /*
       * Canvas에서는 해당 Garbage 선택.
       *
       * 하지만 analyzedRootIds는 그대로이므로
       * Clean 대상은 바뀌지 않는다.
       */
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
     ANALYZE
  ===================================================== */

  if (
    msg.type ===
    "analyze"
  ) {
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


    /*
     * ★ Analyze Root 잠금
     */
    analyzedRootIds =
      selection
        .map(
          node =>
            safeId(node)
        )
        .filter(Boolean);


    const results =
      selection.map(
        root => ({
          name:
            safeName(root),

          rootType:
            safeType(root),

          willConvertToFrame:
            safeType(root) !==
              "FRAME",

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
    /*
     * Analyze를 거치지 않았다면
     * 현재 Selection을 Root로 저장.
     */
    if (
      analyzedRootIds.length === 0
    ) {
      const current =
        [...figma.currentPage.selection]
          .filter(
            node =>
              isAlive(node) &&
              isSupportedRoot(node)
          );


      analyzedRootIds =
        current
          .map(
            node =>
              safeId(node)
          )
          .filter(Boolean);
    }


    const roots =
      await getAnalyzedRoots();


    if (
      roots.length === 0
    ) {
      figma.ui.postMessage({
        type:
          "error",

        message:
          "Analyze했던 Screen을 찾을 수 없습니다. Screen을 다시 선택하고 Analyze Screen을 실행해주세요."
      });

      return;
    }


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


    const resultRoots = [];


    const total = {
      screens:
        roots.length,

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

      geometryRejected: 0,

      finalLayers: 0
    };


    for (
      const root of roots
    ) {
      try {
        const result =
          await processRoot(
            root
          );


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
        console.error(
          "Screen cleanup error:",
          safeName(root),
          error
        );


        if (
          isAlive(root)
        ) {
          resultRoots.push(root);
        }


        total.rolledBack++;
      }
    }


    /*
     * 처리 결과를 다시 선택.
     */
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


      /*
       * 다음 Clean에서도 새 Root ID 사용.
       */
      analyzedRootIds =
        aliveRoots
          .map(
            root =>
              safeId(root)
          )
          .filter(Boolean);
    }


    figma.ui.postMessage({
      type:
        "complete",

      result:
        total
    });


    if (
      total.geometryRejected > 0
    ) {
      figma.notify(
        `Cleanup 완료 · Garbage ${total.removedGarbage}개 삭제 / Container ${total.removedContainers}개 정리 / 화면 변화 위험 ${total.geometryRejected}개는 유지`
      );

    } else {
      figma.notify(
        `Cleanup 완료 · Garbage ${total.removedGarbage}개 삭제 / Container ${total.removedContainers}개 정리`
      );
    }


    return;
  }
};
