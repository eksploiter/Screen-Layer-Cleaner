figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER
   ---------------------------------------------------------
   목표

   1. 최상위 Screen Frame 하나만 유지
   2. 내부 Layer는 최대한 1 Depth
   3. LID는 이름 유지
   4. 일반 Text는 옵션 ON 시 "-"
   5. Garbage는 사용자가 체크한 것만 삭제
   6. Layer Panel 순서:
      위 → 아래
      같은 줄 → 좌 → 우
   7. 겹치는 Layer는 기존 Z-order 유지
   8. 복잡한 Mask / Clip / Effect는 Screenshot Bake
========================================================= */


/* =========================================================
   GLOBAL
========================================================= */

let renameTextToHyphen = false;
let convertFontToInter = false;

let approvedGarbageIds = new Set();
let approvedGarbagePaths = new Set();

const ROW_TOLERANCE = 8;
const MAX_FLATTEN_PASSES = 15;


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

    visualShells: 0,
    bakedAreas: 0,
    preservedAreas: 0,

    convertedTexts: 0,
    convertedFontSegments: 0,
    failedFontConversions: 0,

    finalLayers: 0
  };
}


/* =========================================================
   SAFE NODE HELPERS
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
      "Remove failed:",
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
  const type = safeType(node);

  return (
    type === "FRAME" ||
    type === "GROUP" ||
    type === "COMPONENT" ||
    type === "INSTANCE"
  );
}


function isInsideInstance(node) {
  let current = safeParent(node);

  while (current) {
    if (
      safeType(current) === "INSTANCE"
    ) {
      return true;
    }

    current = safeParent(current);
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


function positionToRelativeTransform(
  x,
  y,
  parent
) {
  return absoluteToRelative(
    [
      [1, 0, x],
      [0, 1, y]
    ],
    parent
  );
}


/* =========================================================
   STRUCTURE PATH
========================================================= */

function buildPathMap(root) {
  const idToPath = new Map();


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
      idToPath.set(
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
      const childPath =
        path === ""
          ? String(i)
          : `${path}/${i}`;


      walk(
        children[i],
        childPath
      );
    }
  }


  walk(
    root,
    ""
  );


  return idToPath;
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
   LID DETECTION
========================================================= */

/*
 * Localization Key 보호.
 *
 * 현재 실사용 규칙 기준.
 */
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
      return "Hidden · visible=false";
    }
  } catch (_) {}


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


function isSelectedGarbage(
  node,
  path
) {
  if (
    getGarbageReason(node) === null
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
    path &&
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
        typeof paint.opacity === "number" &&
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
      fontName.family,
      fontName.style,
      error
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
        segment.fontName ===
          figma.mixed
      ) {
        continue;
      }


      const success =
        await loadFontOnce(
          segment.fontName
        );


      if (!success) {
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
    return style === "Regular"
      ? "Italic"
      : `${style} Italic`;
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
    safeType(node) !==
    "TEXT"
  ) {
    return 0;
  }


  const loaded =
    await ensureTextFontsLoaded(
      node
    );


  if (!loaded) {
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
        segment.fontName &&
        segment.fontName !==
          figma.mixed
          ? segment.fontName.style
          : "Regular";


      const newStyle =
        await loadInterStyle(
          mapFontStyleToInter(
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


function mustBakeContainer(node) {
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


  if (
    containsMask(node)
  ) {
    return true;
  }


  if (
    actuallyClipsChildren(node)
  ) {
    return true;
  }


  try {
    if (
      "opacity" in node &&
      node.opacity !== 1
    ) {
      return true;
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
      return true;
    }
  } catch (_) {}


  if (
    hasVisibleEffects(node)
  ) {
    return true;
  }


  return false;
}


/* =========================================================
   SCREENSHOT BAKE
========================================================= */

async function bakeNode(node) {
  if (!isAlive(node)) {
    return null;
  }


  const bounds =
    safeRenderBounds(node);


  if (
    !bounds ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return null;
  }


  try {
    const bytes =
      await node.exportAsync({
        format:
          "PNG",

        constraint: {
          type:
            "SCALE",

          value:
            1
        }
      });


    return {
      bytes,

      x:
        bounds.x,

      y:
        bounds.y,

      width:
        bounds.width,

      height:
        bounds.height
    };

  } catch (error) {
    console.warn(
      "Bake failed:",
      safeName(node),
      error
    );


    return null;
  }
}


function createScreenshot(
  snapshot,
  root
) {
  if (
    !snapshot ||
    !isAlive(root)
  ) {
    return null;
  }


  try {
    const image =
      figma.createImage(
        snapshot.bytes
      );


    const rect =
      figma.createRectangle();


    rect.name =
      "screenshot";


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


    rect.fills = [
      {
        type:
          "IMAGE",

        scaleMode:
          "FILL",

        imageHash:
          image.hash
      }
    ];


    root.appendChild(rect);


    rect.relativeTransform =
      positionToRelativeTransform(
        snapshot.x,
        snapshot.y,
        root
      );


    return rect;

  } catch (error) {
    console.warn(
      "Screenshot creation failed:",
      error
    );


    return null;
  }
}


/* =========================================================
   INSTANCE
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

      } catch (_) {
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
   ROOT FRAME
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
    target.strokeWeight =
      source.strokeWeight;
  } catch (_) {}


  try {
    target.strokeAlign =
      source.strokeAlign;
  } catch (_) {}


  try {
    target.topLeftRadius =
      source.topLeftRadius;

    target.topRightRadius =
      source.topRightRadius;

    target.bottomLeftRadius =
      source.bottomLeftRadius;

    target.bottomRightRadius =
      source.bottomRightRadius;
  } catch (_) {}


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


  const childData =
    childrenOf(source)
      .map(
        child => ({
          node:
            child,

          transform:
            safeAbsoluteTransform(
              child
            )
        })
      )
      .filter(
        item =>
          item.node &&
          item.transform
      );


  const frame =
    figma.createFrame();


  frame.name =
    safeName(source);


  frame.fills =
    [];


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


  parent.insertChild(
    Math.max(index, 0),
    frame
  );


  frame.relativeTransform =
    absoluteToRelative(
      transform,
      parent
    );


  for (
    const item of childData
  ) {
    if (
      !isAlive(item.node)
    ) {
      continue;
    }


    try {
      frame.appendChild(
        item.node
      );


      item.node.relativeTransform =
        absoluteToRelative(
          item.transform,
          frame
        );

    } catch (_) {}
  }


  if (
    childrenOf(source)
      .length === 0
  ) {
    safeRemove(source);

    return frame;
  }


  safeRemove(frame);

  return source;
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
   GENERIC LAYER NAMING
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


  if (
    name.includes("iphone") ||
    name.includes("i phone")
  ) {
    return true;
  }


  /*
   * 이름이 이상하더라도
   * 일반적인 iPhone 비율에 가까운 경우.
   *
   * 너무 적극적으로 판정하면
   * 일반 Screen까지 iphone이 되므로
   * 이름 우선.
   */
  return false;
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


  /* =====================================================
     TEXT
  ===================================================== */

  if (
    type === "TEXT"
  ) {
    /*
     * LID는 무조건 보호.
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
        node.name = "-";
      } catch (_) {}
    }


    return;
  }


  /* =====================================================
     ICON
  ===================================================== */

  if (
    looksLikeIcon(node)
  ) {
    try {
      node.name =
        "icon";
    } catch (_) {}


    return;
  }


  /* =====================================================
     LINE
  ===================================================== */

  if (
    type === "LINE"
  ) {
    try {
      node.name =
        "line";
    } catch (_) {}


    return;
  }


  /* =====================================================
     RECTANGLE
  ===================================================== */

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


  /* =====================================================
     ELLIPSE
  ===================================================== */

  if (
    type === "ELLIPSE"
  ) {
    try {
      node.name =
        "shape";
    } catch (_) {}


    return;
  }


  /* =====================================================
     GROUP
  ===================================================== */

  if (
    type === "GROUP"
  ) {
    try {
      node.name =
        "group";
    } catch (_) {}


    return;
  }


  /* =====================================================
     FRAME
  ===================================================== */

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


  /* =====================================================
     COMPONENT
  ===================================================== */

  if (
    type === "COMPONENT"
  ) {
    try {
      node.name =
        "component";
    } catch (_) {}


    return;
  }


  /* =====================================================
     INSTANCE
  ===================================================== */

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
  const transform =
    safeAbsoluteTransform(node);


  if (
    !transform ||
    !isAlive(node)
  ) {
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
  if (!snapshot) {
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

  } catch (_) {
    safeRemove(rect);

    return null;
  }
}


/* =========================================================
   MOVE LEAF
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


  /*
   * Text는 Font 먼저 Load.
   */
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
    safeAbsoluteTransform(node);


  if (!transform) {
    return false;
  }


  const oldParent =
    safeParent(node);


  try {
    root.appendChild(node);


    if (
      oldParent !== root
    ) {
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


    stats.movedLayers++;


    return true;

  } catch (error) {
    console.warn(
      "Move failed:",
      safeName(node),
      error
    );


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

    } catch (_) {}


    const snapshot =
      await bakeNode(node);


    if (snapshot) {
      const screenshot =
        createScreenshot(
          snapshot,
          root
        );


      if (screenshot) {
        safeRemove(node);

        stats.bakedAreas++;
        stats.removedContainers++;


        return true;
      }
    }


    stats.preservedAreas++;

    return false;
  }


  /* =====================================================
     COMPLEX CONTAINER
  ===================================================== */

  if (
    mustBakeContainer(node)
  ) {
    const snapshot =
      await bakeNode(node);


    if (snapshot) {
      const screenshot =
        createScreenshot(
          snapshot,
          root
        );


      if (screenshot) {
        safeRemove(node);

        stats.bakedAreas++;
        stats.removedContainers++;


        return true;
      }
    }


    stats.preservedAreas++;

    return false;
  }


  /* =====================================================
     NORMAL FRAME / GROUP
  ===================================================== */

  if (
    hasOwnVisual(node)
  ) {
    const visual =
      snapshotVisual(node);


    const shell =
      createVisualShell(
        visual,
        root
      );


    if (shell) {
      stats.visualShells++;
    }
  }


  const children =
    childrenOf(node);


  let allSucceeded = true;


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


    const result =
      await flattenNode(
        child,
        root,
        stats,
        childPath
      );


    if (!result) {
      allSucceeded =
        false;
    }
  }


  /*
   * Child가 모두 빠졌으면 Container 제거.
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
   * 남아있는 복잡 구조는 Screenshot.
   */
  if (
    isAlive(node)
  ) {
    const snapshot =
      await bakeNode(node);


    if (snapshot) {
      const screenshot =
        createScreenshot(
          snapshot,
          root
        );


      if (screenshot) {
        safeRemove(node);

        stats.bakedAreas++;
        stats.removedContainers++;


        return true;
      }
    }
  }


  stats.preservedAreas++;

  return allSucceeded;
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


  let layoutMode =
    "NONE";


  try {
    layoutMode =
      root.layoutMode;
  } catch (_) {
    return;
  }


  if (
    layoutMode ===
    "NONE"
  ) {
    return;
  }


  const children =
    childrenOf(root);


  const snapshots =
    children.map(
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
   REMAINING CONTAINER
========================================================= */

function rootContainers(root) {
  return childrenOf(root)
    .filter(
      node =>
        isContainer(node)
    );
}


async function removeRemainingContainers(
  root,
  stats
) {
  for (
    let pass = 0;
    pass <
      MAX_FLATTEN_PASSES;
    pass++
  ) {
    const containers =
      rootContainers(root);


    if (
      containers.length === 0
    ) {
      return;
    }


    let progress =
      false;


    for (
      const container of containers
    ) {
      if (!isAlive(container)) {
        continue;
      }


      const before =
        rootContainers(root)
          .length;


      await flattenNode(
        container,
        root,
        stats,
        ""
      );


      const after =
        rootContainers(root)
          .length;


      if (
        after < before
      ) {
        progress = true;
      }
    }


    if (!progress) {
      return;
    }
  }
}


/* =========================================================
   CLEAN ROOT
========================================================= */

async function cleanRoot(
  root,
  stats
) {
  detachInstancesSafely(
    root,
    stats
  );


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


    await flattenNode(
      child,
      root,
      stats,
      String(i)
    );
  }


  await removeRemainingContainers(
    root,
    stats
  );


  stats.finalLayers =
    childrenOf(root)
      .length;
}


/* =========================================================
   LAYER ORDER
========================================================= */

/*
   Figma children order:
   index 0 = 뒤쪽
   마지막 = 앞쪽

   Layer Panel은 반대 방향으로 표시된다.

   따라서 우리가 원하는 Panel 순서:

   A
   B
   C

   를 만들려면 children은:

   C
   B
   A

   가 되어야 한다.
*/


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
 * 화면 읽기 순서:
 *
 * 1. 위 → 아래
 * 2. 같은 높이라면 좌 → 우
 *
 * LID 여부는 전혀 고려하지 않는다.
 * 즉 LID도 일반 Layer와 똑같이 위치 기준 정렬.
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
   * 같은 줄 판정.
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
   * 다른 줄 → 위에서 아래.
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
   * 거의 같은 위치면 좌측 우선.
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
 * 겹치는 Layer끼리는 기존 Z-order를 유지하면서
 * 나머지는 위치순으로 정리.
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
   * 현재 Layer Panel:
   * children의 reverse.
   */
  const originalPanelOrder =
    [...children]
      .reverse();


  /*
   * LID / 일반 Text / Icon / Shape 전부 포함.
   */
  const items =
    originalPanelOrder.map(
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
   * 겹치는 두 Layer는 기존 앞뒤 관계를 유지.
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
   * Z-order constraint를 지키면서
   * 위치 기준 Topological Sort.
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
        available.push(next);
      }
    }
  }


  if (
    desiredPanelOrder.length !==
    items.length
  ) {
    console.warn(
      "Layer ordering aborted."
    );


    return;
  }


  /*
   * desiredPanelOrder
   * = Layer Panel 위 → 아래
   *
   * 실제 children은 반대로.
   */
  const desiredChildrenOrder =
    desiredPanelOrder
      .map(
        item =>
          item.node
      )
      .reverse();


  for (
    let i = 0;
    i <
      desiredChildrenOrder.length;
    i++
  ) {
    const node =
      desiredChildrenOrder[i];


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
        "Layer order failed:",
        safeName(node),
        error
      );


      return;
    }
  }
}


/* =========================================================
   FINAL NAME NORMALIZATION
========================================================= */

function normalizeAllRootChildren(
  root
) {
  for (
    const node of
    childrenOf(root)
  ) {
    normalizeLayerName(
      node,
      root
    );
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
        mustBakeContainer(node)
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

      root:
        originalRoot,

      stats
    };
  }


  /*
   * Garbage Path는 구조 변경 전에 확보.
   */
  approvedGarbagePaths =
    prepareGarbagePaths(
      originalRoot
    );


  /*
   * 다른 Instance 내부의 Screen은
   * 이번 플러그인 대상에서 제외.
   */
  if (
    isInsideInstance(
      originalRoot
    )
  ) {
    return {
      success: false,

      root:
        originalRoot,

      stats
    };
  }


  let root =
    normalizeRoot(
      originalRoot
    );


  if (
    !root ||
    !isAlive(root)
  ) {
    return {
      success: false,

      root:
        originalRoot,

      stats
    };
  }


  if (
    safeType(root) ===
    "INSTANCE"
  ) {
    return {
      success: false,

      root,

      stats
    };
  }


  /*
   * 내부 Flatten.
   */
  await cleanRoot(
    root,
    stats
  );


  /*
   * 혹시 남은 Container 영어명 정리.
   *
   * 정상적으로는 대부분 없어야 하지만
   * 예외적으로 남았을 때도
   * Group 1234 같은 기존 이름은 제거.
   */
  normalizeAllRootChildren(
    root
  );


  /*
   * Layer Panel:
   *
   * 위 → 아래
   * 같은 줄 → 좌 → 우
   *
   * LID도 포함.
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
     GARBAGE DETAIL VIEW
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

          willConvertToFrame:
            safeType(root) !==
              "FRAME",

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

      visualShells: 0,

      bakedAreas: 0,
      preservedAreas: 0,

      convertedTexts: 0,
      convertedFontSegments: 0,
      failedFontConversions: 0,

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
            "Screen cleanup failed:",
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
          `${total.rolledBack}개 Screen은 처리하지 못했습니다.`
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
