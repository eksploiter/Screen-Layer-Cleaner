figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER
   FORCE FLATTEN VERSION

   목표
   ---------------------------------------------------------
   Root Screen 하나만 남긴다.

   Root 아래에는 최종적으로:
   - Text
   - Vector/Icon
   - Line
   - Shape
   - Image
   - Screenshot

   만 존재하도록 한다.

   중간 Container
   - FRAME
   - GROUP
   - COMPONENT
   - INSTANCE

   는 최종적으로 0개가 목표.

   화면 보존이 필요한 Container는
   Preserve하지 않고 screenshot Bake 후 제거한다.
========================================================= */


/* =========================================================
   GLOBAL
========================================================= */

let renameTextToHyphen = false;
let convertFontToInter = false;

let approvedGarbageIds = new Set();

const ROW_TOLERANCE = 6;
const MAX_FLATTEN_PASSES = 20;


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
    invertTransform(
      parentTransform
    ),
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


function shouldDeleteGarbage(node) {
  const id =
    safeId(node);


  if (!id) {
    return false;
  }


  return (
    approvedGarbageIds.has(id) &&
    getGarbageReason(node) !== null
  );
}


/* =========================================================
   FONT
========================================================= */

const loadedFonts = new Set();


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
    style = "Extra Bold";

  } else if (
    value.includes("semi bold") ||
    value.includes("semibold") ||
    value.includes("demi bold")
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


  if (
    !loadedInterStyles.has(
      "Regular"
    )
  ) {
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

    } catch (_) {
      return null;
    }
  }


  return "Regular";
}


async function convertTextToInter(node) {
  if (
    safeType(node) !== "TEXT"
  ) {
    return 0;
  }


  const sourceLoaded =
    await ensureTextFontsLoaded(
      node
    );


  if (!sourceLoaded) {
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


/*
 * 이 경우 Container를 직접 Flatten하지 않고
 * Container 전체를 screenshot으로 Bake.
 */
function mustBakeContainer(node) {
  if (!isContainer(node)) {
    return false;
  }


  /*
   * Detach 못 한 Instance.
   */
  if (
    safeType(node) === "INSTANCE"
  ) {
    return true;
  }


  if (
    containsMask(node)
  ) {
    return true;
  }


  if (
    actuallyClipsChildren(
      node
    )
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

async function createBakeSnapshot(node) {
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
      "Bake export failed:",
      safeName(node),
      error
    );


    return null;
  }
}


function createScreenshotLayer(
  snapshot,
  root
) {
  if (
    !snapshot ||
    !isAlive(root)
  ) {
    return null;
  }


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


  root.appendChild(
    rect
  );


  rect.relativeTransform =
    positionToRelativeTransform(
      snapshot.x,
      snapshot.y,
      root
    );


  return rect;
}


/* =========================================================
   INSTANCE DETACH
========================================================= */

/*
 * 한 번 재귀 순회.
 *
 * Detach 가능한 Instance만 풀고
 * 실패 Instance는 나중에 screenshot Bake.
 */
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
        console.warn(
          "Instance detach skipped:",
          safeName(child),
          error
        );


        continue;
      }
    }


    if (
      isAlive(child) &&
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
   ROOT NORMALIZATION
========================================================= */

function copyValue(
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


function copyRootAppearance(
  source,
  frame
) {
  copyValue(
    source,
    frame,
    "fills"
  );


  copyValue(
    source,
    frame,
    "strokes"
  );


  copyValue(
    source,
    frame,
    "effects"
  );


  try {
    frame.strokeWeight =
      source.strokeWeight;
  } catch (_) {}


  try {
    frame.strokeAlign =
      source.strokeAlign;
  } catch (_) {}


  try {
    frame.topLeftRadius =
      source.topLeftRadius;

    frame.topRightRadius =
      source.topRightRadius;

    frame.bottomLeftRadius =
      source.bottomLeftRadius;

    frame.bottomRightRadius =
      source.bottomRightRadius;
  } catch (_) {}


  try {
    frame.opacity =
      source.opacity;
  } catch (_) {}


  try {
    frame.blendMode =
      source.blendMode;
  } catch (_) {}


  try {
    frame.clipsContent =
      source.clipsContent;
  } catch (_) {}
}


function convertRootToFrame(source) {
  if (!isAlive(source)) {
    return null;
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
   * 다른 Instance 내부 Screen은
   * 안전하게 변환 불가.
   */
  if (
    safeType(parent) ===
      "INSTANCE" ||
    isInsideInstance(parent)
  ) {
    return source;
  }


  const sourceTransform =
    safeAbsoluteTransform(
      source
    );


  if (!sourceTransform) {
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


  const childSnapshots =
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
    safeType(source) !== "GROUP"
  ) {
    copyRootAppearance(
      source,
      frame
    );
  }


  parent.insertChild(
    Math.max(index, 0),
    frame
  );


  try {
    frame.relativeTransform =
      absoluteToRelative(
        sourceTransform,
        parent
      );
  } catch (_) {}


  for (
    const item of childSnapshots
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

    } catch (error) {
      console.warn(
        "Root child move skipped:",
        safeName(item.node),
        error
      );
    }
  }


  /*
   * Child가 하나라도 남았으면
   * source 삭제 금지.
   */
  if (
    childrenOf(source).length > 0
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


  const type =
    safeType(root);


  if (
    type === "FRAME"
  ) {
    return root;
  }


  if (
    type === "INSTANCE"
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

    } catch (error) {
      console.warn(
        "Root Instance detach failed:",
        error
      );


      return root;
    }
  }


  return convertRootToFrame(
    root
  );
}


/* =========================================================
   LAYER NAMING
========================================================= */

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
      root.width > 0 &&
      root.height > 0
    ) {
      return (
        node.width /
          root.width >=
          0.7 &&
        node.height /
          root.height >=
          0.5
      );
    }
  } catch (_) {}


  return false;
}


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


function normalizeLayerName(
  node,
  root
) {
  if (!isAlive(node)) {
    return;
  }


  const type =
    safeType(node);


  if (
    type === "TEXT"
  ) {
    if (
      renameTextToHyphen
    ) {
      try {
        node.name = "-";
      } catch (_) {}
    }


    return;
  }


  if (
    type === "LINE"
  ) {
    try {
      node.name = "line";
    } catch (_) {}


    return;
  }


  if (
    looksLikeIcon(node)
  ) {
    try {
      node.name = "icon";
    } catch (_) {}


    return;
  }


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


  if (
    type === "ELLIPSE"
  ) {
    try {
      node.name =
        "shape";
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
    safeAbsoluteTransform(
      node
    );


  if (!transform) {
    return null;
  }


  const snapshot = {
    width: 1,
    height: 1,

    transform,

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
    snapshot.width =
      node.width;

    snapshot.height =
      node.height;
  } catch (_) {}


  try {
    if (
      node.fills !==
      figma.mixed
    ) {
      snapshot.fills =
        node.fills;
    }
  } catch (_) {}


  try {
    if (
      node.strokes !==
      figma.mixed
    ) {
      snapshot.strokes =
        node.strokes;
    }
  } catch (_) {}


  try {
    snapshot.strokeWeight =
      node.strokeWeight;
  } catch (_) {}


  try {
    snapshot.strokeAlign =
      node.strokeAlign;
  } catch (_) {}


  try {
    snapshot.topLeftRadius =
      node.topLeftRadius || 0;

    snapshot.topRightRadius =
      node.topRightRadius || 0;

    snapshot.bottomLeftRadius =
      node.bottomLeftRadius || 0;

    snapshot.bottomRightRadius =
      node.bottomRightRadius || 0;
  } catch (_) {}


  return snapshot;
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
      snapshot.fills !== null
    ) {
      rect.fills =
        snapshot.fills;
    }
  } catch (_) {}


  try {
    if (
      snapshot.strokes !== null
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
    console.warn(
      "Visual shell failed:",
      error
    );


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


  if (
    safeType(node) === "TEXT"
  ) {
    const fontsReady =
      await ensureTextFontsLoaded(
        node
      );


    if (!fontsReady) {
      /*
       * Text 자체를 이동 못 하면
       * 이후 caller에서 parent bake 판단.
       */
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
      safeType(node) === "TEXT" &&
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
    stats.finalLayers++;


    return true;

  } catch (error) {
    console.warn(
      "Leaf move failed:",
      safeName(node),
      error
    );


    return false;
  }
}


/* =========================================================
   CORE FORCE FLATTEN
========================================================= */

/*
 * 반환값
 *
 * true
 * → 이 Node 처리가 정상적으로 끝남
 *
 * false
 * → 구조 해체 실패
 */

async function flattenNode(
  node,
  root,
  stats
) {
  if (!isAlive(node)) {
    return true;
  }


  /* -----------------------------------------------------
     Garbage
  ----------------------------------------------------- */

  const garbageReason =
    getGarbageReason(
      node
    );


  if (garbageReason) {
    if (
      shouldDeleteGarbage(
        node
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


  /* -----------------------------------------------------
     LEAF
  ----------------------------------------------------- */

  if (
    !isContainer(node)
  ) {
    return await moveLeafToRoot(
      node,
      root,
      stats
    );
  }


  /* -----------------------------------------------------
     INSTANCE
  ----------------------------------------------------- */

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
          stats
        );
      }

    } catch (_) {}


    /*
     * Detach 실패 → screenshot.
     */
    const snapshot =
      await createBakeSnapshot(
        node
      );


    if (snapshot) {
      const screenshot =
        createScreenshotLayer(
          snapshot,
          root
        );


      if (screenshot) {
        safeRemove(node);

        stats.bakedAreas++;
        stats.removedContainers++;
        stats.finalLayers++;


        return true;
      }
    }


    stats.preservedAreas++;

    return false;
  }


  /* -----------------------------------------------------
     RISKY CONTAINER
  ----------------------------------------------------- */

  if (
    mustBakeContainer(node)
  ) {
    const snapshot =
      await createBakeSnapshot(
        node
      );


    if (snapshot) {
      const screenshot =
        createScreenshotLayer(
          snapshot,
          root
        );


      if (screenshot) {
        safeRemove(node);

        stats.bakedAreas++;
        stats.removedContainers++;
        stats.finalLayers++;


        return true;
      }
    }


    /*
     * Bake마저 실패.
     */
    stats.preservedAreas++;

    return false;
  }


  /* -----------------------------------------------------
     SAFE CONTAINER
  ----------------------------------------------------- */

  /*
   * Container 자체 Background / Stroke.
   */
  if (
    hasOwnVisual(node)
  ) {
    const snapshot =
      snapshotVisual(
        node
      );


    if (snapshot) {
      const shell =
        createVisualShell(
          snapshot,
          root
        );


      if (shell) {
        stats.visualShells++;
        stats.finalLayers++;
      }
    }
  }


  const children =
    childrenOf(node);


  /*
   * 모든 Child 처리.
   */
  let allChildrenProcessed = true;


  for (
    const child of children
  ) {
    if (!isAlive(child)) {
      continue;
    }


    const success =
      await flattenNode(
        child,
        root,
        stats
      );


    if (!success) {
      allChildrenProcessed = false;
    }
  }


  /*
   * Child 중 하나라도 실패했다면
   * Container 삭제하면 안 됨.
   *
   * 그러나 우리의 목표는 Container 0개이므로
   * 남아있는 Container 전체를 screenshot fallback.
   */
  if (
    !allChildrenProcessed &&
    isAlive(node)
  ) {
    const snapshot =
      await createBakeSnapshot(
        node
      );


    if (snapshot) {
      const screenshot =
        createScreenshotLayer(
          snapshot,
          root
        );


      if (screenshot) {
        safeRemove(node);

        stats.bakedAreas++;
        stats.removedContainers++;
        stats.finalLayers++;


        return true;
      }
    }


    stats.preservedAreas++;

    return false;
  }


  /*
   * 정상 처리 후 Container 제거.
   */
  if (
    isAlive(node)
  ) {
    const remaining =
      childrenOf(node);


    if (
      remaining.length === 0
    ) {
      if (
        safeRemove(node)
      ) {
        stats.removedContainers++;
      }


      return true;
    }


    /*
     * 예상치 못하게 자식이 남음
     * → Container 전체 Bake.
     */
    const snapshot =
      await createBakeSnapshot(
        node
      );


    if (snapshot) {
      const screenshot =
        createScreenshotLayer(
          snapshot,
          root
        );


      if (screenshot) {
        safeRemove(node);

        stats.bakedAreas++;
        stats.removedContainers++;
        stats.finalLayers++;


        return true;
      }
    }


    stats.preservedAreas++;

    return false;
  }


  return true;
}


/* =========================================================
   FORCE REMAINING CONTAINER PASS
========================================================= */

function getRootContainers(root) {
  return childrenOf(root)
    .filter(
      child =>
        isContainer(child)
    );
}


/*
 * Root 아래 Container가 0개가 될 때까지
 * 재처리한다.
 */
async function forceRemoveRemainingContainers(
  root,
  stats
) {
  for (
    let pass = 0;
    pass < MAX_FLATTEN_PASSES;
    pass++
  ) {
    const containers =
      getRootContainers(
        root
      );


    if (
      containers.length === 0
    ) {
      return;
    }


    let progress = 0;


    for (
      const container of containers
    ) {
      if (!isAlive(container)) {
        continue;
      }


      const beforeCount =
        getRootContainers(root)
          .length;


      await flattenNode(
        container,
        root,
        stats
      );


      const afterCount =
        getRootContainers(root)
          .length;


      if (
        afterCount < beforeCount
      ) {
        progress++;
      }
    }


    /*
     * 아무 변화도 없으면 무한루프 방지.
     */
    if (
      progress === 0
    ) {
      break;
    }
  }
}


/* =========================================================
   ROOT CLEAN
========================================================= */

async function cleanRoot(root) {
  const stats =
    createStats();


  /*
   * 내부 Instance 한 번 선제 Detach.
   */
  detachInstancesSafely(
    root,
    stats
  );


  /*
   * Root Auto Layout 해제.
   */
  try {
    if (
      safeType(root) ===
        "FRAME" &&
      root.layoutMode !==
        "NONE"
    ) {
      root.layoutMode =
        "NONE";
    }
  } catch (_) {}


  /*
   * Root child snapshot.
   */
  const children =
    childrenOf(root);


  for (
    const child of children
  ) {
    if (!isAlive(child)) {
      continue;
    }


    try {
      await flattenNode(
        child,
        root,
        stats
      );

    } catch (error) {
      console.warn(
        "Flatten skipped:",
        safeName(child),
        error
      );


      stats.preservedAreas++;
    }
  }


  /*
   * 남은 Root Container 강제 제거.
   */
  await forceRemoveRemainingContainers(
    root,
    stats
  );


  return stats;
}


/* =========================================================
   LAYER ORDER
========================================================= */

function getSimpleBounds(node) {
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


function boundsOverlap(a, b) {
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


function canSpatiallySort(root) {
  const children =
    childrenOf(root);


  const items =
    children.map(
      node => ({
        bounds:
          getSimpleBounds(node)
      })
    );


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
      if (
        boundsOverlap(
          items[i].bounds,
          items[j].bounds
        )
      ) {
        return false;
      }
    }
  }


  return true;
}


function sortSpatiallyIfSafe(root) {
  if (
    !isAlive(root) ||
    !hasChildren(root)
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


  /*
   * 겹침이 있으면 Z-order 우선.
   */
  if (
    !canSpatiallySort(root)
  ) {
    return;
  }


  const items =
    children.map(
      (node, originalIndex) => ({
        node,

        bounds:
          getSimpleBounds(node),

        originalIndex
      })
    );


  items.sort(
    (a, b) => {
      if (
        !a.bounds ||
        !b.bounds
      ) {
        return (
          a.originalIndex -
          b.originalIndex
        );
      }


      /*
       * 같은 높이 → 좌 → 우
       */
      if (
        Math.abs(
          a.bounds.y -
          b.bounds.y
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


      return (
        a.originalIndex -
        b.originalIndex
      );
    }
  );


  /*
   * Layer Panel에서는 역순으로 보이므로 reverse.
   */
  const figmaOrder =
    [...items]
      .reverse();


  for (
    let i = 0;
    i < figmaOrder.length;
    i++
  ) {
    const node =
      figmaOrder[i].node;


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


    const currentPath =
      path
        ? `${path} / ${name}`
        : name;


    const garbageReason =
      getGarbageReason(
        node
      );


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
        mustBakeContainer(
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
  const emptyStats =
    createStats();


  if (!isAlive(originalRoot)) {
    return {
      success: false,
      root: originalRoot,
      stats: emptyStats
    };
  }


  /*
   * Screen 자체가 다른 Instance 내부라면
   * 직접 변경 불가.
   */
  if (
    isInsideInstance(
      originalRoot
    )
  ) {
    return {
      success: false,
      root: originalRoot,
      stats: emptyStats
    };
  }


  let root =
    originalRoot;


  try {
    root =
      normalizeRoot(
        originalRoot
      ) ||
      originalRoot;

  } catch (error) {
    console.warn(
      "Root normalization failed:",
      safeName(originalRoot),
      error
    );
  }


  if (!isAlive(root)) {
    return {
      success: false,
      root: originalRoot,
      stats: emptyStats
    };
  }


  /*
   * Root Instance가 끝까지 남았다면
   * 직접 정리하지 않는다.
   */
  if (
    safeType(root) ===
      "INSTANCE"
  ) {
    return {
      success: false,
      root,
      stats: emptyStats
    };
  }


  const stats =
    await cleanRoot(
      root
    );


  /*
   * 최종 Container 검사.
   */
  const remainingContainers =
    getRootContainers(
      root
    );


  /*
   * 네 요구사항 기준 정상은 0개.
   */
  if (
    remainingContainers.length >
    0
  ) {
    console.warn(
      "Remaining containers:",
      remainingContainers.map(
        node =>
          safeName(node)
      )
    );
  }


  /*
   * 안전한 경우 Layer Panel 정렬.
   */
  sortSpatiallyIfSafe(
    root
  );


  /*
   * 최종 실제 Layer 수.
   */
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
   UI MESSAGE
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
     GARBAGE VIEW
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


    const resultRoots = [];


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

      } else if (
        total.bakedAreas > 0
      ) {
        figma.notify(
          `Cleanup 완료 · 복잡 영역 ${total.bakedAreas}개는 screenshot으로 보존했습니다.`
        );

      } else {
        figma.notify(
          "Cleanup 완료 · 1 Depth"
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
