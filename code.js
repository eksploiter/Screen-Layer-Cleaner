figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER
   SAFE FLATTEN VERSION

   핵심 원칙
   ---------------------------------------------------------
   1. 화면 보존이 가장 중요
   2. 가능한 Layer만 1 Depth
   3. 위험한 Container는 Preserve
   4. 전체 Screen은 최대한 실패시키지 않음

   기존 기능
   ---------------------------------------------------------
   - Garbage Analyze
   - 체크한 Garbage만 삭제
   - LID 이름 보호
   - 일반 Text "-" 옵션
   - Inter 변환 옵션
   - icon / line / shape / image / screenshot
   - frame / group / instance / component / iphone
   - 위 → 아래
   - 같은 줄 → 좌 → 우
   - 겹치는 Layer는 기존 Z-order 보호
========================================================= */


/* =========================================================
   GLOBAL
========================================================= */

let renameTextToHyphen = false;
let convertFontToInter = false;

let approvedGarbageIds = new Set();
let approvedGarbagePaths = new Set();

const ROW_TOLERANCE = 8;

const MAX_ANCESTOR_DETACH = 10;


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
   TYPE HELPERS
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


function isInsideInstance(node) {
  let current = safeParent(node);

  while (current) {
    if (
      safeType(current) === "INSTANCE"
    ) {
      return true;
    }

    current =
      safeParent(current);
  }

  return false;
}


function findNearestInstanceAncestor(node) {
  let current = safeParent(node);

  while (current) {
    if (
      safeType(current) === "INSTANCE"
    ) {
      return current;
    }

    current =
      safeParent(current);
  }

  return null;
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
  const map =
    buildPathMap(root);


  const paths =
    new Set();


  for (
    const id of
    approvedGarbageIds
  ) {
    const path =
      map.get(id);


    if (
      path !== undefined
    ) {
      paths.add(path);
    }
  }


  return paths;
}


/* =========================================================
   RELATIVE CHILD PATH
========================================================= */

/*
 * ancestor
 *   └ ...
 *      └ target
 *
 * target까지의 child index 배열
 */
function getPathFromAncestor(
  ancestor,
  target
) {
  const path = [];

  let current =
    target;


  while (
    current &&
    current !== ancestor
  ) {
    const parent =
      safeParent(current);


    if (
      !parent ||
      !hasChildren(parent)
    ) {
      return null;
    }


    let index = -1;


    try {
      index =
        parent.children.indexOf(
          current
        );
    } catch (_) {
      return null;
    }


    if (
      index < 0
    ) {
      return null;
    }


    path.unshift(index);

    current =
      parent;
  }


  if (
    current !== ancestor
  ) {
    return null;
  }


  return path;
}


function followChildPath(
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


/* =========================================================
   DETACH ANCESTOR INSTANCE
========================================================= */

/*
 * 선택 Screen이 Instance 안에 있더라도
 * 바로 실패하지 않는다.
 *
 * 가장 가까운 Instance 조상을 Detach하고
 * 같은 child path를 따라 선택 Screen을 다시 찾는다.
 *
 * 실패하면 그냥 원래 Node를 반환한다.
 */
function tryDetachAncestorInstances(
  selectedRoot,
  stats
) {
  let root =
    selectedRoot;


  for (
    let round = 0;
    round < MAX_ANCESTOR_DETACH;
    round++
  ) {
    if (!isAlive(root)) {
      break;
    }


    const instance =
      findNearestInstanceAncestor(
        root
      );


    if (!instance) {
      break;
    }


    const path =
      getPathFromAncestor(
        instance,
        root
      );


    if (!path) {
      break;
    }


    try {
      const detached =
        instance.detachInstance();


      if (
        !detached ||
        !isAlive(detached)
      ) {
        break;
      }


      stats.detachedInstances++;


      const resolved =
        followChildPath(
          detached,
          path
        );


      if (
        resolved &&
        isAlive(resolved)
      ) {
        root =
          resolved;

      } else {
        /*
         * 구조가 바뀌어서
         * target을 다시 찾지 못한 경우
         * detached root 자체를 사용하지 않는다.
         */
        break;
      }

    } catch (error) {
      console.warn(
        "Ancestor Instance detach skipped:",
        safeName(instance),
        error
      );


      break;
    }
  }


  return root;
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
    style = "Black";

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
    style = "Bold";

  } else if (
    value.includes("medium")
  ) {
    style = "Medium";

  } else if (
    value.includes("extra light") ||
    value.includes("extralight")
  ) {
    style =
      "Extra Light";

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


  const ready =
    await ensureTextFontsLoaded(
      node
    );


  if (!ready) {
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
   PRESERVE RULE
========================================================= */

/*
 * TRUE인 Container는
 * 내부를 강제로 1 Depth로 풀지 않는다.
 *
 * 대신 Container 자체를 Root 직속으로 올린다.
 */
function shouldPreserveContainer(node) {
  if (!isContainer(node)) {
    return false;
  }


  /*
   * detach되지 않은 Instance
   */
  if (
    safeType(node) ===
    "INSTANCE"
  ) {
    return true;
  }


  /*
   * Mask
   */
  if (
    containsMask(node)
  ) {
    return true;
  }


  /*
   * 실제 Clip
   */
  if (
    actuallyClipsChildren(node)
  ) {
    return true;
  }


  /*
   * Parent opacity
   */
  try {
    if (
      "opacity" in node &&
      node.opacity !== 1
    ) {
      return true;
    }
  } catch (_) {}


  /*
   * Blend
   */
  try {
    if (
      "blendMode" in node &&
      node.blendMode !==
        "PASS_THROUGH" &&
      node.blendMode !==
        "NORMAL"
    ) {
      return true;
    }
  } catch (_) {}


  /*
   * Shadow / Blur
   */
  if (
    hasVisibleEffects(node)
  ) {
    return true;
  }


  return false;
}


/* =========================================================
   INTERNAL INSTANCE DETACH
========================================================= */

function detachInstancesSafely(
  parent,
  stats
) {
  const children =
    childrenOf(parent);


  for (
    const originalChild of children
  ) {
    if (!isAlive(originalChild)) {
      continue;
    }


    let child =
      originalChild;


    if (
      safeType(child) ===
      "INSTANCE"
    ) {
      try {
        const detached =
          child.detachInstance();


        if (
          detached &&
          isAlive(detached)
        ) {
          child =
            detached;

          stats.detachedInstances++;
        }

      } catch (error) {
        /*
         * 실패한 Instance는
         * later preserve
         */
        console.warn(
          "Instance preserved:",
          safeName(child)
        );


        continue;
      }
    }


    if (
      hasChildren(child)
    ) {
      detachInstancesSafely(
        child,
        stats
      );
    }
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
     * LID는 유지
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
        looksLikeIPhoneFrame(node)
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
   VISUAL SHELL
========================================================= */

function snapshotVisual(node) {
  if (!isAlive(node)) {
    return null;
  }


  const transform =
    safeAbsoluteTransform(node);


  if (!transform) {
    return null;
  }


  const result = {
    transform,

    width: 1,
    height: 1,

    fills: null,
    strokes: null,

    strokeWeight: null,
    strokeAlign: null,

    topLeftRadius: 0,
    topRightRadius: 0,
    bottomLeftRadius: 0,
    bottomRightRadius: 0
  };


  try {
    result.width =
      node.width;

    result.height =
      node.height;
  } catch (_) {}


  try {
    if (
      node.fills !==
      figma.mixed
    ) {
      result.fills =
        node.fills;
    }
  } catch (_) {}


  try {
    if (
      node.strokes !==
      figma.mixed
    ) {
      result.strokes =
        node.strokes;
    }
  } catch (_) {}


  try {
    result.strokeWeight =
      node.strokeWeight;

    result.strokeAlign =
      node.strokeAlign;
  } catch (_) {}


  try {
    result.topLeftRadius =
      node.topLeftRadius || 0;

    result.topRightRadius =
      node.topRightRadius || 0;

    result.bottomLeftRadius =
      node.bottomLeftRadius || 0;

    result.bottomRightRadius =
      node.bottomRightRadius || 0;
  } catch (_) {}


  return result;
}


function createVisualShell(
  snapshot,
  root
) {
  if (
    !snapshot ||
    !isAlive(root)
  ) {
    return null;
  }


  const rect =
    figma.createRectangle();


  rect.name =
    "shape";


  rect.resize(
    Math.max(
      snapshot.width,
      0.01
    ),

    Math.max(
      snapshot.height,
      0.01
    )
  );


  try {
    if (
      snapshot.fills !==
      null
    ) {
      rect.fills =
        snapshot.fills;
    }
  } catch (_) {}


  try {
    if (
      snapshot.strokes !==
      null
    ) {
      rect.strokes =
        snapshot.strokes;
    }
  } catch (_) {}


  try {
    if (
      snapshot.strokeWeight !==
      null
    ) {
      rect.strokeWeight =
        snapshot.strokeWeight;
    }
  } catch (_) {}


  try {
    if (
      snapshot.strokeAlign !==
      null
    ) {
      rect.strokeAlign =
        snapshot.strokeAlign;
    }
  } catch (_) {}


  try {
    rect.topLeftRadius =
      snapshot.topLeftRadius;

    rect.topRightRadius =
      snapshot.topRightRadius;

    rect.bottomLeftRadius =
      snapshot.bottomLeftRadius;

    rect.bottomRightRadius =
      snapshot.bottomRightRadius;
  } catch (_) {}


  try {
    root.appendChild(rect);


    rect.relativeTransform =
      absoluteToRelative(
        snapshot.transform,
        root
      );


    return rect;

  } catch (error) {
    safeRemove(rect);

    return null;
  }
}


/* =========================================================
   ROOT NORMALIZATION
========================================================= */

function copyProperty(
  source,
  target,
  key
) {
  try {
    if (
      key in source &&
      key in target &&
      source[key] !==
        figma.mixed
    ) {
      target[key] =
        source[key];
    }
  } catch (_) {}
}


function copyAppearance(
  source,
  target
) {
  copyProperty(
    source,
    target,
    "fills"
  );


  copyProperty(
    source,
    target,
    "strokes"
  );


  copyProperty(
    source,
    target,
    "effects"
  );


  try {
    target.opacity =
      source.opacity;
  } catch (_) {}


  try {
    target.blendMode =
      source.blendMode;
  } catch (_) {}


  try {
    target.clipsContent =
      source.clipsContent;
  } catch (_) {}


  try {
    target.strokeWeight =
      source.strokeWeight;
  } catch (_) {}


  try {
    target.strokeAlign =
      source.strokeAlign;
  } catch (_) {}
}


function convertRootToFrame(source) {
  if (!isAlive(source)) {
    return source;
  }


  const parent =
    safeParent(source);


  if (
    !parent ||
    !("children" in parent)
  ) {
    return source;
  }


  /*
   * 아직 Instance 내부라면
   * 강제 Frame 교체하지 않는다.
   */
  if (
    safeType(parent) ===
      "INSTANCE" ||
    isInsideInstance(parent)
  ) {
    return source;
  }


  const transform =
    safeAbsoluteTransform(source);


  if (!transform) {
    return source;
  }


  let width = 1;
  let height = 1;
  let index = 0;


  try {
    width =
      source.width;

    height =
      source.height;

    index =
      parent.children.indexOf(
        source
      );
  } catch (_) {}


  const children =
    childrenOf(source)
      .map(
        child => ({
          child,

          transform:
            safeAbsoluteTransform(
              child
            )
        })
      );


  const frame =
    figma.createFrame();


  frame.name =
    safeName(source);


  frame.fills = [];


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


  try {
    frame.layoutMode =
      "NONE";
  } catch (_) {}


  if (
    safeType(source) !==
    "GROUP"
  ) {
    copyAppearance(
      source,
      frame
    );
  }


  try {
    parent.insertChild(
      Math.max(
        index,
        0
      ),
      frame
    );


    frame.relativeTransform =
      absoluteToRelative(
        transform,
        parent
      );

  } catch (_) {
    safeRemove(frame);

    return source;
  }


  for (
    const item of children
  ) {
    if (
      !item.transform ||
      !isAlive(item.child)
    ) {
      continue;
    }


    try {
      frame.appendChild(
        item.child
      );


      item.child.relativeTransform =
        absoluteToRelative(
          item.transform,
          frame
        );

    } catch (_) {}
  }


  /*
   * 하나라도 Child가 남았으면
   * 원본 삭제 금지.
   */
  if (
    childrenOf(source).length >
    0
  ) {
    safeRemove(frame);

    return source;
  }


  safeRemove(source);


  return frame;
}


function normalizeRoot(root) {
  if (!isAlive(root)) {
    return null;
  }


  if (
    safeType(root) ===
    "FRAME"
  ) {
    return root;
  }


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
        if (
          safeType(detached) ===
          "FRAME"
        ) {
          return detached;
        }


        return convertRootToFrame(
          detached
        );
      }

    } catch (_) {
      return root;
    }
  }


  return convertRootToFrame(
    root
  );
}


/* =========================================================
   ROOT AUTO LAYOUT
========================================================= */

function disableRootAutoLayoutSafely(
  root
) {
  if (
    safeType(root) !==
    "FRAME"
  ) {
    return;
  }


  let mode = "NONE";


  try {
    mode =
      root.layoutMode;
  } catch (_) {
    return;
  }


  if (
    mode === "NONE"
  ) {
    return;
  }


  const snapshots =
    childrenOf(root)
      .map(
        node => ({
          node,

          transform:
            safeAbsoluteTransform(
              node
            )
        })
      );


  try {
    root.layoutMode =
      "NONE";
  } catch (_) {
    return;
  }


  for (
    const item of snapshots
  ) {
    if (
      !item.transform ||
      !isAlive(item.node)
    ) {
      continue;
    }


    try {
      item.node.relativeTransform =
        absoluteToRelative(
          item.transform,
          root
        );
    } catch (_) {}
  }
}


/* =========================================================
   MOVE
========================================================= */

async function moveLeafToRoot(
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


  if (
    safeType(node) ===
    "TEXT"
  ) {
    const fontReady =
      await ensureTextFontsLoaded(
        node
      );


    /*
     * Font Load 실패 시
     * 이 Text는 Preserve.
     */
    if (!fontReady) {
      return false;
    }
  }


  const transform =
    safeAbsoluteTransform(node);


  if (!transform) {
    return false;
  }


  const oldParent =
    safeParent(node);


  try {
    /*
     * 이미 Root Child여도
     * appendChild 하면 Z-order가 달라질 수 있으므로
     * 그대로 둔다.
     */
    if (
      oldParent !== root
    ) {
      root.appendChild(node);


      node.relativeTransform =
        absoluteToRelative(
          transform,
          root
        );
    }


    if (
      safeType(node) ===
        "TEXT" &&
      convertFontToInter
    ) {
      const count =
        await convertTextToInter(
          node
        );


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


    stats.movedLayers++;


    return true;

  } catch (error) {
    console.warn(
      "Move skipped:",
      safeName(node),
      error
    );


    return false;
  }
}


/* =========================================================
   PRESERVE CONTAINER
========================================================= */

async function preserveContainerAtRoot(
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
   * 내부 Instance에 갇혀 있으면
   * 강제 재부모화 금지.
   */
  if (
    isInsideInstance(node)
  ) {
    stats.preservedAreas++;

    normalizeLayerName(
      node,
      root
    );


    return false;
  }


  const transform =
    safeAbsoluteTransform(node);


  if (!transform) {
    stats.preservedAreas++;

    return false;
  }


  try {
    if (
      safeParent(node) !== root
    ) {
      root.appendChild(node);


      node.relativeTransform =
        absoluteToRelative(
          transform,
          root
        );
    }


    normalizeLayerName(
      node,
      root
    );


    stats.preservedAreas++;


    return true;

  } catch (error) {
    stats.preservedAreas++;


    return false;
  }
}


/* =========================================================
   FLATTEN
========================================================= */

async function flattenNode(
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
        safeRemove(node)
      ) {
        stats.removedGarbage++;
      }


      return true;
    }


    stats.protectedGarbage++;
  }


  /* =====================================================
     LEAF
  ===================================================== */

  if (
    !isContainer(node)
  ) {
    return await moveLeafToRoot(
      node,
      root,
      stats
    );
  }


  /* =====================================================
     INSTANCE
  ===================================================== */

  if (
    safeType(node) ===
    "INSTANCE"
  ) {
    try {
      const detached =
        node.detachInstance();


      if (
        detached &&
        isAlive(detached)
      ) {
        stats.detachedInstances++;


        return await flattenNode(
          detached,
          root,
          stats,
          path
        );
      }

    } catch (error) {
      /*
       * Detach 실패
       * → Instance 자체 Preserve
       */
      await preserveContainerAtRoot(
        node,
        root,
        stats
      );


      return false;
    }
  }


  /* =====================================================
     COMPLEX CONTAINER
  ===================================================== */

  if (
    shouldPreserveContainer(node)
  ) {
    await preserveContainerAtRoot(
      node,
      root,
      stats
    );


    return true;
  }


  /* =====================================================
     SAFE CONTAINER
  ===================================================== */

  /*
   * Container 자체 Fill/Stroke가 있다면
   * shape로 재현.
   */
  if (
    hasOwnVisual(node)
  ) {
    const visual =
      snapshotVisual(node);


    if (visual) {
      const shell =
        createVisualShell(
          visual,
          root
        );


      if (shell) {
        stats.visualShells++;
      }
    }
  }


  const children =
    childrenOf(node);


  let allChildrenMoved =
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
      await flattenNode(
        child,
        root,
        stats,
        childPath
      );


    if (!success) {
      allChildrenMoved =
        false;
    }
  }


  /*
   * 비었으면 Container 삭제.
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
    }


    return true;
  }


  /*
   * 일부 Child가 남으면
   * 이 Container는 더 이상 억지로 건드리지 않는다.
   */
  if (
    isAlive(node)
  ) {
    await preserveContainerAtRoot(
      node,
      root,
      stats
    );
  }


  return allChildrenMoved;
}


/* =========================================================
   CLEAN ROOT
========================================================= */

async function cleanRoot(
  root,
  stats
) {
  /*
   * 내부 Instance는 가능한 것만 Detach.
   */
  detachInstancesSafely(
    root,
    stats
  );


  /*
   * 최상위 Auto Layout 해제.
   */
  disableRootAutoLayoutSafely(
    root
  );


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
      await flattenNode(
        child,
        root,
        stats,
        String(i)
      );

    } catch (error) {
      /*
       * 개별 Layer 오류는 전체 실패 금지.
       */
      console.warn(
        "Layer preserved after error:",
        safeName(child),
        error
      );


      stats.preservedAreas++;
    }
  }


  /*
   * 최종 Root Child는 모두 이름 정리.
   */
  for (
    const child of
    childrenOf(root)
  ) {
    normalizeLayerName(
      child,
      root
    );
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
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}


/*
 * 위 → 아래
 * 같은 줄 → 좌 → 우
 *
 * 이름은 전혀 고려하지 않는다.
 *
 * 즉 LID도 동일하게 정렬.
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
   * 같은 행
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
   * 다른 행
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


  /*
   * 거의 동일
   */
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
 * 겹치는 Layer끼리는 기존 Z-order 고정.
 *
 * 그 제약 안에서
 * 위 → 아래 / 좌 → 우 정렬.
 */
function sortLayersTopToBottom(
  root
) {
  const children =
    childrenOf(root);


  if (
    children.length <= 1
  ) {
    return;
  }


  /*
   * Figma Layer Panel은
   * children 역순.
   */
  const panelOrder =
    [...children]
      .reverse();


  const items =
    panelOrder.map(
      (node, index) => ({
        node,

        bounds:
          getSpatialBounds(
            node
          ),

        originalPanelIndex:
          index,

        outgoing:
          new Set(),

        indegree:
          0
      })
    );


  /*
   * 겹치는 Layer끼리는
   * 기존 Panel 순서 유지.
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
   * Panel 위→아래를
   * children 배열로 넣을 때는 반전.
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
        "Layer order stopped:",
        safeName(node),
        error
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
     * 이제 의미는 Preserve 후보.
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


    if (
      node !== root &&
      isContainer(node)
    ) {
      result.containers++;


      if (
        shouldPreserveContainer(
          node
        )
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


    try {
      if (
        "layoutMode" in node &&
        node.layoutMode !==
          "NONE"
      ) {
        result.autoLayouts++;
      }
    } catch (_) {}


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
      actuallyClipsChildren(
        node
      )
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
   * 구조 바꾸기 전에 확보.
   */
  approvedGarbagePaths =
    prepareGarbagePaths(
      originalRoot
    );


  /*
   * 부모 Instance 안에 있으면
   * 가능한 만큼 상위 Instance 해제.
   */
  let root =
    tryDetachAncestorInstances(
      originalRoot,
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
   * 그래도 Instance 안에 있다면
   * 해당 Root 내부를 강제로 밖으로 빼지는 않는다.
   *
   * 그래도 이름 정리 등의 가벼운 처리는
   * 가능한 범위에서 수행.
   */
  const stillInsideInstance =
    isInsideInstance(root);


  if (
    !stillInsideInstance
  ) {
    root =
      normalizeRoot(root) ||
      root;
  }


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
   * Root가 여전히 Instance면
   * 내부 강제 Flatten 안 함.
   */
  if (
    safeType(root) ===
      "INSTANCE"
  ) {
    normalizeLayerName(
      root,
      root
    );


    stats.preservedAreas++;


    return {
      success: true,
      root,
      stats
    };
  }


  /*
   * 일반 Frame / Group / Component
   */
  await cleanRoot(
    root,
    stats
  );


  /*
   * 최종 Root Children 명칭 정리
   */
  for (
    const child of
    childrenOf(root)
  ) {
    normalizeLayerName(
      child,
      root
    );
  }


  /*
   * 위치 정렬
   *
   * LID 포함
   */
  sortLayersTopToBottom(
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
            isAlive(result.root)
          ) {
            resultRoots.push(
              result.root
            );
          }


          /*
           * 이번 버전에서는
           * Preserve가 있어도 성공.
           */
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
          /*
           * 한 Screen 오류로 전체 중단 X
           */
          console.warn(
            "Screen cleanup skipped:",
            safeName(
              originalRoot
            ),
            error
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


          total.rolledBack++;
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
        total.rolledBack > 0
      ) {
        figma.notify(
          `Cleanup 완료 · ${total.rolledBack}개 Screen은 처리 중 일부 영역을 유지했습니다.`
        );

      } else if (
        total.preservedAreas > 0
      ) {
        figma.notify(
          `Cleanup 완료 · 복잡한 영역 ${total.preservedAreas}개는 화면 보호를 위해 유지했습니다.`
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
