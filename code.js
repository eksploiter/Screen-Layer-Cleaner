figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER

   핵심 원칙
   ---------------------------------------------------------
   1. 디자인 화면은 절대 변하지 않는다.
   2. 원본에는 직접 작업하지 않는다.
   3. Working Copy는 PAGE 직속으로 분리한다.
   4. Instance는 가능한 한 모두 Detach한다.
   5. 삭제/Detach 후 stale node 접근을 방지한다.
   6. Cleanup 후 Before / After PNG가 같을 때만 Commit.
   7. 실패하면 Working Copy 제거 + 원본 유지.
========================================================= */


/* =========================================================
   GLOBAL
========================================================= */

let renameTextToHyphen = false;
let convertFontToInter = false;

let approvedGarbageOriginalIds = new Set();
let approvedGarbagePaths = new Set();
let unavailableFontPaths = new Set();

const ROW_TOLERANCE = 6;
const MAX_DETACH_ROUNDS = 50;

const TEMP_PLUGIN_KEY =
  "screen-layer-cleaner-temp";


/* =========================================================
   SAFE NODE ACCESS
========================================================= */

/*
 * Figma에서는 삭제된 SceneNode 객체를
 * 참조하고 있는 것 자체는 가능하지만,
 *
 * node.parent
 * node.absoluteTransform
 * node.type
 *
 * 같은 property를 읽는 순간
 *
 * "The node with id ... does not exist"
 *
 * 오류가 날 수 있다.
 *
 * 따라서 삭제/Detach 이후의 node 접근은
 * 반드시 이 helper들을 통해 방어한다.
 */

function isNodeAlive(node) {
  if (!node) {
    return false;
  }

  try {
    const parent = node.parent;

    return !!parent;
  } catch (_) {
    return false;
  }
}


function safeNodeType(node) {
  try {
    return node.type;
  } catch (_) {
    return null;
  }
}


function safeNodeName(node) {
  try {
    return node.name;
  } catch (_) {
    return "(deleted node)";
  }
}


function safeParent(node) {
  try {
    return node.parent;
  } catch (_) {
    return null;
  }
}


function safeAbsoluteTransform(node) {
  try {
    return node.absoluteTransform;
  } catch (_) {
    return null;
  }
}


function safeAbsoluteBoundingBox(node) {
  try {
    return node.absoluteBoundingBox;
  } catch (_) {
    return null;
  }
}


function safeAbsoluteRenderBounds(node) {
  try {
    return node.absoluteRenderBounds;
  } catch (_) {
    return null;
  }
}


function safeRemove(node) {
  if (!isNodeAlive(node)) {
    return false;
  }

  try {
    node.remove();
    return true;
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
      "Parent transform을 읽을 수 없습니다."
    );
  }

  const inverse =
    invertTransform(
      parentTransform
    );

  return multiplyTransform(
    inverse,
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
   NODE HELPERS
========================================================= */

function hasChildren(node) {
  if (!isNodeAlive(node)) {
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


function getChildrenSnapshot(node) {
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
  const type =
    safeNodeType(node);

  return (
    type === "FRAME" ||
    type === "GROUP" ||
    type === "COMPONENT" ||
    type === "INSTANCE"
  );
}


function isSupportedRoot(node) {
  const type =
    safeNodeType(node);

  return (
    type === "FRAME" ||
    type === "GROUP" ||
    type === "COMPONENT" ||
    type === "INSTANCE"
  );
}


function isIconType(node) {
  const type =
    safeNodeType(node);

  return (
    type === "VECTOR" ||
    type === "BOOLEAN_OPERATION" ||
    type === "STAR" ||
    type === "POLYGON" ||
    type === "ELLIPSE"
  );
}


function isInsideInstance(node) {
  if (!isNodeAlive(node)) {
    return false;
  }

  try {
    let current =
      node.parent;

    while (current) {
      if (
        current.type === "INSTANCE"
      ) {
        return true;
      }

      current =
        current.parent;
    }

    return false;

  } catch (_) {
    return false;
  }
}


/* =========================================================
   STRUCTURAL PATH
========================================================= */

function buildNodePathMap(root) {
  const idToPath =
    new Map();

  const pathToNode =
    new Map();


  function walk(
    node,
    path
  ) {
    if (!isNodeAlive(node)) {
      return;
    }

    try {
      idToPath.set(
        node.id,
        path
      );

      pathToNode.set(
        path,
        node
      );
    } catch (_) {
      return;
    }


    const children =
      getChildrenSnapshot(
        node
      );

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


  return {
    idToPath,
    pathToNode
  };
}


/* =========================================================
   PAINT HELPERS
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
  if (!isNodeAlive(node)) {
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
      fill => {
        return (
          fill.type === "IMAGE" &&
          fill.visible !== false
        );
      }
    );

  } catch (_) {
    return false;
  }
}


function hasVisibleEffects(node) {
  if (!isNodeAlive(node)) {
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
  if (!isNodeAlive(node)) {
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
  if (!isNodeAlive(node)) {
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


  try {
    if (
      node.type === "SLICE"
    ) {
      return "Slice Layer";
    }
  } catch (_) {}


  return null;
}


/* =========================================================
   FONT PRELOAD
========================================================= */

function getTextFonts(node) {
  if (
    safeNodeType(node) !==
    "TEXT"
  ) {
    return [];
  }

  try {
    const segments =
      node.getStyledTextSegments(
        ["fontName"]
      );

    const fonts =
      [];

    for (
      const segment of segments
    ) {
      if (
        segment.fontName &&
        segment.fontName !==
          figma.mixed
      ) {
        fonts.push({
          family:
            segment.fontName.family,

          style:
            segment.fontName.style
        });
      }
    }

    return fonts;

  } catch (_) {}


  try {
    if (
      node.fontName &&
      node.fontName !==
        figma.mixed
    ) {
      return [
        {
          family:
            node.fontName.family,

          style:
            node.fontName.style
        }
      ];
    }
  } catch (_) {}


  return [];
}


async function preloadFonts(
  root
) {
  const pathMap =
    buildNodePathMap(
      root
    );

  const fontMap =
    new Map();

  const textFontKeys =
    new Map();


  function walk(node) {
    if (!isNodeAlive(node)) {
      return;
    }


    if (
      safeNodeType(node) ===
      "TEXT"
    ) {
      let nodeId = null;

      try {
        nodeId = node.id;
      } catch (_) {}

      const path =
        nodeId
          ? pathMap.idToPath.get(
              nodeId
            )
          : undefined;


      const fonts =
        getTextFonts(
          node
        );

      const keys =
        [];

      for (
        const font of fonts
      ) {
        const key =
          `${font.family}::${font.style}`;

        fontMap.set(
          key,
          font
        );

        keys.push(
          key
        );
      }

      if (
        path !== undefined
      ) {
        textFontKeys.set(
          path,
          keys
        );
      }
    }


    for (
      const child of
      getChildrenSnapshot(node)
    ) {
      walk(child);
    }
  }


  walk(root);


  const failedFontKeys =
    new Set();


  for (
    const [key, font]
    of fontMap.entries()
  ) {
    try {
      await figma.loadFontAsync({
        family:
          font.family,

        style:
          font.style
      });

    } catch (error) {
      console.warn(
        "Font preload failed:",
        font.family,
        font.style,
        error
      );

      failedFontKeys.add(
        key
      );
    }
  }


  const failedPaths =
    new Set();


  for (
    const [path, keys]
    of textFontKeys.entries()
  ) {
    if (
      keys.some(
        key =>
          failedFontKeys.has(
            key
          )
      )
    ) {
      failedPaths.add(
        path
      );
    }
  }


  return {
    failedPaths,
    failedFontKeys
  };
}


/* =========================================================
   INTER FONT
========================================================= */

const loadedInterStyles =
  new Set();


function mapFontStyleToInter(
  styleName
) {
  const value =
    String(
      styleName || ""
    )
      .toLowerCase()
      .replace(
        /[_-]/g,
        " "
      );


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
    weight =
      "Extra Bold";

  } else if (
    value.includes("semi bold") ||
    value.includes("semibold") ||
    value.includes("demi bold")
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
    value.includes("extra light") ||
    value.includes("extralight")
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
    if (
      weight === "Regular"
    ) {
      return "Italic";
    }

    return (
      `${weight} Italic`
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


  if (
    !loadedInterStyles.has(
      "Regular"
    )
  ) {
    await figma.loadFontAsync({
      family:
        "Inter",

      style:
        "Regular"
    });

    loadedInterStyles.add(
      "Regular"
    );
  }


  return "Regular";
}


async function convertTextToInter(
  node
) {
  if (
    safeNodeType(node) !==
    "TEXT"
  ) {
    return 0;
  }


  try {
    const segments =
      node.getStyledTextSegments(
        ["fontName"]
      );

    let converted =
      0;


    for (
      const segment of segments
    ) {
      const sourceStyle =
        segment.fontName &&
        segment.fontName !==
          figma.mixed
          ? segment.fontName.style
          : "Regular";


      const mapped =
        mapFontStyleToInter(
          sourceStyle
        );


      const style =
        await loadInterStyle(
          mapped
        );


      node.setRangeFontName(
        segment.start,
        segment.end,
        {
          family:
            "Inter",

          style
        }
      );


      converted++;
    }


    return converted;

  } catch (error) {
    console.warn(
      "Inter conversion failed:",
      safeNodeName(node),
      error
    );

    return 0;
  }
}


/* =========================================================
   MASK / CLIP
========================================================= */

function containsMask(node) {
  if (!hasChildren(node)) {
    return false;
  }


  for (
    const child of
    getChildrenSnapshot(node)
  ) {
    if (!isNodeAlive(child)) {
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
  if (!isNodeAlive(node)) {
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


  const children =
    getChildrenSnapshot(node);


  if (
    children.length === 0
  ) {
    return false;
  }


  const parentBounds =
    safeAbsoluteBoundingBox(
      node
    );


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
    const child of children
  ) {
    if (!isNodeAlive(child)) {
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
      safeAbsoluteRenderBounds(
        child
      ) ||
      safeAbsoluteBoundingBox(
        child
      );


    if (!bounds) {
      continue;
    }


    const childRight =
      bounds.x +
      bounds.width;

    const childBottom =
      bounds.y +
      bounds.height;


    if (
      bounds.x <
        left - 0.5 ||

      bounds.y <
        top - 0.5 ||

      childRight >
        right + 0.5 ||

      childBottom >
        bottom + 0.5
    ) {
      return true;
    }
  }


  return false;
}


function needsBake(node) {
  if (!isContainer(node)) {
    return false;
  }


  if (
    safeNodeType(node) ===
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
   INSTANCE DETACH
========================================================= */

function collectInstances(root) {
  const instances =
    [];


  function walk(
    node,
    depth
  ) {
    if (!isNodeAlive(node)) {
      return;
    }


    if (
      safeNodeType(node) ===
      "INSTANCE"
    ) {
      instances.push({
        id:
          node.id,

        depth
      });
    }


    for (
      const child of
      getChildrenSnapshot(node)
    ) {
      walk(
        child,
        depth + 1
      );
    }
  }


  walk(
    root,
    0
  );


  return instances;
}


/*
 * 중요:
 * instance 객체를 오래 저장하지 않고
 * ID만 저장한 뒤 매번 다시 getNodeByIdAsync 한다.
 *
 * detachInstance() 이후 stale reference를
 * 다시 만지는 문제를 줄이기 위한 방식.
 */
async function detachAllInstances(
  root,
  stats
) {
  for (
    let round = 0;
    round < MAX_DETACH_ROUNDS;
    round++
  ) {
    const instances =
      collectInstances(
        root
      );


    if (
      instances.length === 0
    ) {
      return;
    }


    instances.sort(
      (a, b) =>
        b.depth -
        a.depth
    );


    let successCount =
      0;


    for (
      const item of instances
    ) {
      let instance = null;

      try {
        instance =
          await figma.getNodeByIdAsync(
            item.id
          );
      } catch (_) {
        continue;
      }


      if (
        !instance ||
        safeNodeType(instance) !==
          "INSTANCE" ||
        !isNodeAlive(instance)
      ) {
        continue;
      }


      try {
        instance.detachInstance();

        stats.detachedInstances++;

        successCount++;

      } catch (error) {
        console.warn(
          "Instance detach failed:",
          safeNodeName(instance),
          error
        );
      }
    }


    if (
      successCount === 0
    ) {
      return;
    }
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
  if (
    !isNodeAlive(source) ||
    !isNodeAlive(target)
  ) {
    return;
  }


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


function copyRootVisualProperties(
  source,
  frame
) {
  copyProperty(
    source,
    frame,
    "fills"
  );

  copyProperty(
    source,
    frame,
    "strokes"
  );

  copyProperty(
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


function replaceRootWithFrame(
  source
) {
  if (!isNodeAlive(source)) {
    throw new Error(
      "Root 변환 대상이 이미 삭제되었습니다."
    );
  }


  const parent =
    safeParent(
      source
    );


  if (
    !parent ||
    !("children" in parent)
  ) {
    throw new Error(
      "Working Root Parent를 찾을 수 없습니다."
    );
  }


  let sourceIndex = 0;

  try {
    sourceIndex =
      parent.children.indexOf(
        source
      );
  } catch (_) {}


  const sourceTransform =
    safeAbsoluteTransform(
      source
    );


  if (!sourceTransform) {
    throw new Error(
      "Root Transform을 읽을 수 없습니다."
    );
  }


  const sourceName =
    safeNodeName(
      source
    );


  let sourceWidth = 1;
  let sourceHeight = 1;


  try {
    sourceWidth =
      source.width;

    sourceHeight =
      source.height;
  } catch (_) {}


  /*
   * Child Node 객체와 transform을 같이 저장하되
   * 이동 직전마다 생존 여부 재확인.
   */
  const childSnapshots =
    getChildrenSnapshot(
      source
    )
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
          item.transform !==
          null
      );


  const frame =
    figma.createFrame();


  frame.setPluginData(
    TEMP_PLUGIN_KEY,
    "true"
  );


  frame.name =
    sourceName;


  frame.fills =
    [];


  frame.resize(
    Math.max(
      sourceWidth,
      0.01
    ),

    Math.max(
      sourceHeight,
      0.01
    )
  );


  try {
    frame.layoutMode =
      "NONE";
  } catch (_) {}


  if (
    safeNodeType(source) !==
    "GROUP"
  ) {
    copyRootVisualProperties(
      source,
      frame
    );
  }


  parent.insertChild(
    Math.max(
      sourceIndex,
      0
    ),
    frame
  );


  frame.relativeTransform =
    absoluteToRelative(
      sourceTransform,
      parent
    );


  for (
    const item of childSnapshots
  ) {
    if (
      !isNodeAlive(
        item.node
      )
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
        "Root child move failed:",
        safeNodeName(item.node),
        error
      );
    }
  }


  safeRemove(
    source
  );


  return frame;
}


function normalizeRootToFrame(
  node
) {
  if (!isNodeAlive(node)) {
    throw new Error(
      "Working Root가 이미 삭제되었습니다."
    );
  }


  const type =
    safeNodeType(
      node
    );


  if (
    type === "FRAME"
  ) {
    node.setPluginData(
      TEMP_PLUGIN_KEY,
      "true"
    );

    return node;
  }


  if (
    type === "INSTANCE"
  ) {
    try {
      const detached =
        node.detachInstance();


      if (!isNodeAlive(detached)) {
        throw new Error(
          "Root detach 결과가 유효하지 않습니다."
        );
      }


      detached.setPluginData(
        TEMP_PLUGIN_KEY,
        "true"
      );


      if (
        safeNodeType(detached) ===
        "FRAME"
      ) {
        return detached;
      }


      return replaceRootWithFrame(
        detached
      );

    } catch (error) {
      console.warn(
        "Root Instance detach failed:",
        error
      );

      /*
       * detach 실패 시 무리하게 내부를 꺼내지 않는다.
       * Root 자체를 새 Frame으로 재구성 시도.
       */
      return replaceRootWithFrame(
        node
      );
    }
  }


  return replaceRootWithFrame(
    node
  );
}


/* =========================================================
   NAMING
========================================================= */

function isScreenshotLayer(
  node,
  root
) {
  if (
    safeNodeType(node) !==
      "RECTANGLE" ||
    !hasImageFill(node)
  ) {
    return false;
  }


  try {
    if (
      root.width <= 0 ||
      root.height <= 0
    ) {
      return false;
    }


    const widthRatio =
      node.width /
      root.width;


    const heightRatio =
      node.height /
      root.height;


    return (
      widthRatio >= 0.7 &&
      heightRatio >= 0.5
    );

  } catch (_) {
    return false;
  }
}


function normalizeLayerName(
  node,
  root
) {
  if (!isNodeAlive(node)) {
    return;
  }


  const type =
    safeNodeType(node);


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
      node.name =
        "line";
    } catch (_) {}

    return;
  }


  if (
    isIconType(node)
  ) {
    try {
      node.name =
        "icon";
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
          isScreenshotLayer(
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
  }
}


/* =========================================================
   VISUAL SHELL
========================================================= */

function snapshotContainerVisual(
  node
) {
  if (!isNodeAlive(node)) {
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

    fills:
      null,

    strokes:
      null,

    effects:
      null,

    strokeWeight:
      null,

    strokeAlign:
      null,

    topLeftRadius:
      0,

    topRightRadius:
      0,

    bottomLeftRadius:
      0,

    bottomRightRadius:
      0
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
    snapshot.effects =
      node.effects;
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
    !isNodeAlive(root)
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
      snapshot.effects !==
      null
    ) {
      rect.effects =
        snapshot.effects;
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


  root.appendChild(
    rect
  );


  rect.relativeTransform =
    absoluteToRelative(
      snapshot.transform,
      root
    );


  return rect;
}


/* =========================================================
   BAKE
========================================================= */

async function createBakeSnapshot(
  node
) {
  if (!isNodeAlive(node)) {
    return null;
  }


  const bounds =
    safeAbsoluteRenderBounds(
      node
    ) ||
    safeAbsoluteBoundingBox(
      node
    );


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
            2
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
      safeNodeName(node),
      error
    );

    return null;
  }
}


function createBakedScreenshot(
  snapshot,
  root
) {
  if (
    !snapshot ||
    !isNodeAlive(root)
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
   FLATTEN PLAN
========================================================= */

/*
 * 중요한 변경:
 *
 * plan에 node object만 저장하지 않고
 * 가능한 경우 id도 같이 저장한다.
 *
 * 실행 시 stale 가능성이 있으면
 * id로 다시 조회한다.
 */

async function buildFlattenPlan(
  root,
  stats
) {
  const plan =
    [];


  async function visit(
    node,
    path
  ) {
    if (!isNodeAlive(node)) {
      return;
    }


    let nodeId = null;

    try {
      nodeId = node.id;
    } catch (_) {}


    const garbageReason =
      getGarbageReason(
        node
      );


    if (
      garbageReason
    ) {
      if (
        approvedGarbagePaths.has(
          path
        )
      ) {
        plan.push({
          type:
            "garbage",

          nodeId
        });

      } else {
        plan.push({
          type:
            "preserve",

          nodeId
        });


        stats.protectedGarbage++;
      }


      return;
    }


    /*
     * load 불가능 Text는
     * 이동하지 않고 Bake.
     */
    if (
      safeNodeType(node) ===
        "TEXT" &&
      unavailableFontPaths.has(
        path
      )
    ) {
      const snapshot =
        await createBakeSnapshot(
          node
        );


      if (snapshot) {
        plan.push({
          type:
            "bake",

          snapshot
        });

        stats.bakedAreas++;

      } else {
        plan.push({
          type:
            "preserve",

          nodeId
        });

        stats.preservedAreas++;
      }


      return;
    }


    if (
      isContainer(node)
    ) {
      if (
        needsBake(node)
      ) {
        const snapshot =
          await createBakeSnapshot(
            node
          );


        if (snapshot) {
          plan.push({
            type:
              "bake",

            snapshot
          });

          stats.bakedAreas++;

          return;
        }


        plan.push({
          type:
            "preserve",

          nodeId
        });

        stats.preservedAreas++;

        return;
      }


      if (
        hasOwnVisual(node)
      ) {
        const shellSnapshot =
          snapshotContainerVisual(
            node
          );


        if (
          shellSnapshot
        ) {
          plan.push({
            type:
              "shell",

            snapshot:
              shellSnapshot
          });
        }
      }


      const children =
        getChildrenSnapshot(
          node
        );


      for (
        let i = 0;
        i < children.length;
        i++
      ) {
        const childPath =
          path === ""
            ? String(i)
            : `${path}/${i}`;


        await visit(
          children[i],
          childPath
        );
      }


      return;
    }


    const transform =
      safeAbsoluteTransform(
        node
      );


    if (!transform) {
      return;
    }


    plan.push({
      type:
        "leaf",

      nodeId,

      transform
    });
  }


  const children =
    getChildrenSnapshot(
      root
    );


  for (
    let i = 0;
    i < children.length;
    i++
  ) {
    await visit(
      children[i],
      String(i)
    );
  }


  return plan;
}


/* =========================================================
   NODE RESOLVE
========================================================= */

async function resolveNodeById(
  nodeId
) {
  if (!nodeId) {
    return null;
  }


  try {
    const node =
      await figma.getNodeByIdAsync(
        nodeId
      );


    if (
      !node ||
      node.type === "DOCUMENT" ||
      node.type === "PAGE"
    ) {
      return null;
    }


    if (
      !isNodeAlive(node)
    ) {
      return null;
    }


    return node;

  } catch (_) {
    return null;
  }
}


/* =========================================================
   EXECUTE PLAN
========================================================= */

async function executeFlattenPlan(
  root,
  plan,
  stats
) {
  /*
   * original child는 node object가 아니라 ID로 저장.
   * stale reference 방지.
   */
  const originalChildIds =
    getChildrenSnapshot(
      root
    )
      .map(
        node => {
          try {
            return node.id;
          } catch (_) {
            return null;
          }
        }
      )
      .filter(Boolean);


  /* -----------------------------------------------------
     GARBAGE
  ----------------------------------------------------- */

  for (
    const item of plan
  ) {
    if (
      item.type !==
      "garbage"
    ) {
      continue;
    }


    const node =
      await resolveNodeById(
        item.nodeId
      );


    if (!node) {
      continue;
    }


    if (
      safeRemove(node)
    ) {
      stats.removedGarbage++;
    }
  }


  /* -----------------------------------------------------
     BUILD
  ----------------------------------------------------- */

  for (
    const item of plan
  ) {
    if (
      item.type ===
      "garbage"
    ) {
      continue;
    }


    if (
      item.type ===
      "shell"
    ) {
      const shell =
        createVisualShell(
          item.snapshot,
          root
        );


      if (shell) {
        stats.visualShells++;
        stats.finalLayers++;
      }


      continue;
    }


    if (
      item.type ===
      "bake"
    ) {
      const baked =
        createBakedScreenshot(
          item.snapshot,
          root
        );


      if (baked) {
        stats.finalLayers++;
      }


      continue;
    }


    if (
      item.type ===
      "preserve"
    ) {
      const node =
        await resolveNodeById(
          item.nodeId
        );


      if (!node) {
        continue;
      }


      const parent =
        safeParent(
          node
        );


      if (!parent) {
        continue;
      }


      if (
        parent === root
      ) {
        stats.finalLayers++;
        continue;
      }


      /*
       * Instance 아래면 강제 이동 금지.
       */
      if (
        isInsideInstance(node)
      ) {
        const snapshot =
          await createBakeSnapshot(
            node
          );


        if (snapshot) {
          createBakedScreenshot(
            snapshot,
            root
          );

          stats.bakedAreas++;
          stats.finalLayers++;

        } else {
          stats.preservedAreas++;
        }


        continue;
      }


      const transform =
        safeAbsoluteTransform(
          node
        );


      if (!transform) {
        stats.preservedAreas++;
        continue;
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


        stats.finalLayers++;

      } catch (error) {
        console.warn(
          "Preserve move failed:",
          safeNodeName(node),
          error
        );


        const snapshot =
          await createBakeSnapshot(
            node
          );


        if (snapshot) {
          createBakedScreenshot(
            snapshot,
            root
          );

          stats.bakedAreas++;
          stats.finalLayers++;

        } else {
          stats.preservedAreas++;
        }
      }


      continue;
    }


    if (
      item.type ===
      "leaf"
    ) {
      const node =
        await resolveNodeById(
          item.nodeId
        );


      if (!node) {
        continue;
      }


      if (
        isInsideInstance(node)
      ) {
        const snapshot =
          await createBakeSnapshot(
            node
          );


        if (snapshot) {
          createBakedScreenshot(
            snapshot,
            root
          );

          stats.bakedAreas++;
          stats.finalLayers++;

        } else {
          stats.preservedAreas++;
        }


        continue;
      }


      try {
        root.appendChild(
          node
        );


        node.relativeTransform =
          absoluteToRelative(
            item.transform,
            root
          );


        if (
          safeNodeType(node) ===
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
        stats.finalLayers++;

      } catch (error) {
        console.warn(
          "Leaf move failed:",
          safeNodeName(node),
          error
        );


        /*
         * move 실패 시 같은 node를
         * 다시 바로 만지면 stale일 수도 있으므로
         * ID 재조회.
         */
        const retryNode =
          await resolveNodeById(
            item.nodeId
          );


        if (!retryNode) {
          stats.preservedAreas++;
          continue;
        }


        const snapshot =
          await createBakeSnapshot(
            retryNode
          );


        if (snapshot) {
          createBakedScreenshot(
            snapshot,
            root
          );

          stats.bakedAreas++;
          stats.finalLayers++;

        } else {
          stats.preservedAreas++;
        }
      }
    }
  }


  /* -----------------------------------------------------
     REMOVE OLD CONTAINERS
  ----------------------------------------------------- */

  /*
   * 기존 object 배열을 사용하지 않고
   * ID 기반으로 다시 조회.
   */
  for (
    const childId of
    originalChildIds
  ) {
    const child =
      await resolveNodeById(
        childId
      );


    if (!child) {
      continue;
    }


    const preserved =
      plan.some(
        item =>
          item.type === "preserve" &&
          item.nodeId === childId
      );


    const leaf =
      plan.some(
        item =>
          item.type === "leaf" &&
          item.nodeId === childId
      );


    if (
      preserved ||
      leaf
    ) {
      continue;
    }


    if (
      isContainer(child)
    ) {
      if (
        safeRemove(child)
      ) {
        stats.removedContainers++;
      }
    }
  }
}


/* =========================================================
   SAFE ORDERING
========================================================= */

function getBounds(node) {
  const bounds =
    safeAbsoluteBoundingBox(
      node
    );


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
      a.originalIndex -
      b.originalIndex
    );
  }


  if (
    Math.abs(
      a.bounds.y -
      b.bounds.y
    ) <= ROW_TOLERANCE
  ) {
    const x =
      a.bounds.x -
      b.bounds.x;


    if (
      Math.abs(x) >
      0.1
    ) {
      return x;
    }
  }


  const y =
    a.bounds.y -
    b.bounds.y;


  if (
    Math.abs(y) >
    0.1
  ) {
    return y;
  }


  return (
    a.originalIndex -
    b.originalIndex
  );
}


function sortLayersSafely(root) {
  if (!hasChildren(root)) {
    return;
  }


  const children =
    getChildrenSnapshot(
      root
    );


  if (
    children.length <= 1
  ) {
    return;
  }


  /*
   * Panel order
   */
  const panelOrder =
    [...children]
      .reverse();


  const items =
    panelOrder
      .filter(
        node =>
          isNodeAlive(node)
      )
      .map(
        (node, index) => ({
          nodeId:
            node.id,

          bounds:
            getBounds(node),

          originalIndex:
            index,

          outgoing:
            new Set(),

          indegree:
            0
        })
      );


  const itemMap =
    new Map();


  for (
    const item of items
  ) {
    itemMap.set(
      item.nodeId,
      item
    );
  }


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
      const a =
        items[i];

      const b =
        items[j];


      if (
        boundsOverlap(
          a.bounds,
          b.bounds
        )
      ) {
        a.outgoing.add(
          b.nodeId
        );

        b.indegree++;
      }
    }
  }


  const available =
    items.filter(
      item =>
        item.indegree === 0
    );


  const sorted =
    [];


  while (
    available.length > 0
  ) {
    available.sort(
      compareSpatial
    );


    const current =
      available.shift();


    sorted.push(
      current
    );


    for (
      const nextId of
      current.outgoing
    ) {
      const next =
        itemMap.get(
          nextId
        );


      if (!next) {
        continue;
      }


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
    sorted.length !==
    items.length
  ) {
    console.warn(
      "Safe sorting aborted."
    );

    return;
  }


  const finalIds =
    sorted
      .map(
        item =>
          item.nodeId
      )
      .reverse();


  /*
   * stale 방지를 위해 ID 재조회 대신
   * 현재 root children에서 id match.
   */
  for (
    let i = 0;
    i < finalIds.length;
    i++
  ) {
    const currentChildren =
      getChildrenSnapshot(
        root
      );


    const target =
      currentChildren.find(
        node => {
          try {
            return (
              node.id ===
              finalIds[i]
            );
          } catch (_) {
            return false;
          }
        }
      );


    if (!target) {
      continue;
    }


    try {
      root.insertChild(
        i,
        target
      );

    } catch (error) {
      console.warn(
        "Safe sorting failed:",
        safeNodeName(target),
        error
      );

      return;
    }
  }
}


/* =========================================================
   VISUAL EXPORT
========================================================= */

async function exportVisual(node) {
  if (!isNodeAlive(node)) {
    throw new Error(
      "Visual Export 대상이 존재하지 않습니다."
    );
  }


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
}


function byteArraysEqual(
  a,
  b
) {
  if (
    !a ||
    !b ||
    a.length !== b.length
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
   TEMP CLEANUP
========================================================= */

function getTemporaryRoots() {
  try {
    return figma.currentPage.findAll(
      node => {
        try {
          return (
            node.getPluginData(
              TEMP_PLUGIN_KEY
            ) === "true"
          );
        } catch (_) {
          return false;
        }
      }
    );

  } catch (_) {
    return [];
  }
}


function removeTemporaryRoots(
  exceptNode = null
) {
  const tempNodes =
    getTemporaryRoots();


  /*
   * 현재 page에 존재하는 temp 중
   * 최상위 것만 제거.
   */
  for (
    const node of tempNodes
  ) {
    if (!isNodeAlive(node)) {
      continue;
    }


    if (
      exceptNode &&
      isNodeAlive(exceptNode)
    ) {
      try {
        if (
          node.id ===
          exceptNode.id
        ) {
          continue;
        }
      } catch (_) {}
    }


    let current =
      safeParent(
        node
      );


    let hasTempAncestor =
      false;


    while (
      current &&
      safeNodeType(current) !==
        "PAGE"
    ) {
      try {
        if (
          current.getPluginData &&
          current.getPluginData(
            TEMP_PLUGIN_KEY
          ) === "true"
        ) {
          hasTempAncestor =
            true;

          break;
        }
      } catch (_) {}


      current =
        safeParent(
          current
        );
    }


    if (
      hasTempAncestor
    ) {
      continue;
    }


    safeRemove(
      node
    );
  }
}


/* =========================================================
   WORKING COPY
========================================================= */

function createPageWorkingCopy(
  original
) {
  if (!isNodeAlive(original)) {
    throw new Error(
      "Original Screen이 존재하지 않습니다."
    );
  }


  const clone =
    original.clone();


  clone.setPluginData(
    TEMP_PLUGIN_KEY,
    "true"
  );


  figma.currentPage.appendChild(
    clone
  );


  const bounds =
    safeAbsoluteBoundingBox(
      original
    );


  try {
    if (bounds) {
      clone.x =
        bounds.x +
        100000;

      clone.y =
        bounds.y +
        100000;

    } else {
      clone.x =
        100000;

      clone.y =
        100000;
    }
  } catch (_) {}


  return clone;
}


/* =========================================================
   CLEAN WORKING ROOT
========================================================= */

async function cleanWorkingRoot(
  root
) {
  const stats = {
    detachedInstances:
      0,

    removedGarbage:
      0,

    protectedGarbage:
      0,

    removedContainers:
      0,

    movedLayers:
      0,

    visualShells:
      0,

    bakedAreas:
      0,

    preservedAreas:
      0,

    convertedTexts:
      0,

    convertedFontSegments:
      0,

    failedFontConversions:
      0,

    finalLayers:
      0
  };


  await detachAllInstances(
    root,
    stats
  );


  /*
   * Detach 후 path 구조가 바뀔 수 있기 때문에
   * 여기서 중요한 점이 하나 있다.
   *
   * Garbage Path는 원본 구조 기준이고
   * detach로 구조가 달라질 수 있다.
   *
   * 따라서 승인 Garbage는 이미 화면에 영향을
   * 안 주는 요소이고, 안전성을 위해
   * detach 이전 path 기반 matching을 우선 사용한다.
   */


  const plan =
    await buildFlattenPlan(
      root,
      stats
    );


  try {
    if (
      root.layoutMode !==
      "NONE"
    ) {
      root.layoutMode =
        "NONE";
    }
  } catch (_) {}


  await executeFlattenPlan(
    root,
    plan,
    stats
  );


  sortLayersSafely(
    root
  );


  return stats;
}


/* =========================================================
   GARBAGE PATH
========================================================= */

function buildApprovedGarbagePaths(
  originalRoot
) {
  const map =
    buildNodePathMap(
      originalRoot
    );


  const result =
    new Set();


  for (
    const originalId of
    approvedGarbageOriginalIds
  ) {
    const path =
      map.idToPath.get(
        originalId
      );


    if (
      path !== undefined
    ) {
      result.add(
        path
      );
    }
  }


  return result;
}


/* =========================================================
   COMMIT
========================================================= */

function commitWorkingRoot(
  original,
  working
) {
  if (
    !isNodeAlive(original) ||
    !isNodeAlive(working)
  ) {
    throw new Error(
      "Commit 대상 Root가 존재하지 않습니다."
    );
  }


  const parent =
    safeParent(
      original
    );


  if (
    !parent ||
    !("children" in parent)
  ) {
    throw new Error(
      "Original Parent를 찾을 수 없습니다."
    );
  }


  if (
    safeNodeType(parent) ===
      "INSTANCE" ||
    isInsideInstance(parent)
  ) {
    throw new Error(
      "선택한 Screen이 다른 Instance 내부에 있어 안전하게 Commit할 수 없습니다."
    );
  }


  let index = 0;

  try {
    index =
      parent.children.indexOf(
        original
      );
  } catch (_) {}


  const originalTransform =
    safeAbsoluteTransform(
      original
    );


  if (!originalTransform) {
    throw new Error(
      "Original transform을 읽을 수 없습니다."
    );
  }


  working.setPluginData(
    TEMP_PLUGIN_KEY,
    ""
  );


  parent.insertChild(
    Math.max(
      index,
      0
    ),
    working
  );


  working.relativeTransform =
    absoluteToRelative(
      originalTransform,
      parent
    );


  safeRemove(
    original
  );


  return working;
}


/* =========================================================
   TRANSACTION
========================================================= */

async function cleanWithProtection(
  original
) {
  let working =
    null;

  let committed =
    false;

  let stats =
    null;


  try {
    /* ---------------------------------------------------
       Font Preload
    --------------------------------------------------- */

    const fontResult =
      await preloadFonts(
        original
      );


    unavailableFontPaths =
      fontResult.failedPaths;


    /* ---------------------------------------------------
       Garbage IDs → Paths
    --------------------------------------------------- */

    approvedGarbagePaths =
      buildApprovedGarbagePaths(
        original
      );


    /* ---------------------------------------------------
       BEFORE
    --------------------------------------------------- */

    const before =
      await exportVisual(
        original
      );


    /* ---------------------------------------------------
       Working Copy
    --------------------------------------------------- */

    working =
      createPageWorkingCopy(
        original
      );


    /* ---------------------------------------------------
       Root Normalize
    --------------------------------------------------- */

    working =
      normalizeRootToFrame(
        working
      );


    if (!isNodeAlive(working)) {
      throw new Error(
        "Root Frame 변환에 실패했습니다."
      );
    }


    working.setPluginData(
      TEMP_PLUGIN_KEY,
      "true"
    );


    /* ---------------------------------------------------
       Clean
    --------------------------------------------------- */

    stats =
      await cleanWorkingRoot(
        working
      );


    if (!isNodeAlive(working)) {
      throw new Error(
        "Cleanup 중 Working Root가 삭제되었습니다."
      );
    }


    /* ---------------------------------------------------
       AFTER
    --------------------------------------------------- */

    const after =
      await exportVisual(
        working
      );


    /* ---------------------------------------------------
       VISUAL VERIFY
    --------------------------------------------------- */

    const visualMatch =
      byteArraysEqual(
        before,
        after
      );


    if (!visualMatch) {
      return {
        success:
          false,

        root:
          original,

        stats,

        reason:
          "Visual Verification Failed"
      };
    }


    /* ---------------------------------------------------
       COMMIT
    --------------------------------------------------- */

    const committedRoot =
      commitWorkingRoot(
        original,
        working
      );


    working =
      committedRoot;


    committed =
      true;


    return {
      success:
        true,

      root:
        committedRoot,

      stats,

      reason:
        null
    };


  } catch (error) {
    console.error(
      "Cleanup transaction error:",
      error
    );


    return {
      success:
        false,

      root:
        original,

      stats:
        stats || {
          detachedInstances:
            0,

          removedGarbage:
            0,

          protectedGarbage:
            0,

          removedContainers:
            0,

          movedLayers:
            0,

          visualShells:
            0,

          bakedAreas:
            0,

          preservedAreas:
            0,

          convertedTexts:
            0,

          convertedFontSegments:
            0,

          failedFontConversions:
            0,

          finalLayers:
            0
        },

      reason:
        error &&
        error.message
          ? error.message
          : String(error)
    };


  } finally {
    /*
     * 성공 여부와 관계없이
     * TEMP Node 강제 정리.
     *
     * Commit 성공한 working에는
     * TEMP data를 이미 제거했으므로
     * 아래 cleanup 대상에 잡히지 않는다.
     */
    removeTemporaryRoots();
  }
}


/* =========================================================
   ANALYZE
========================================================= */

function analyzeScreen(root) {
  const result = {
    total:
      0,

    garbage:
      0,

    garbageItems:
      [],

    containers:
      0,

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


  function walk(
    node,
    path
  ) {
    if (!isNodeAlive(node)) {
      return;
    }


    result.total++;


    const nodeName =
      safeNodeName(
        node
      );


    const currentPath =
      path
        ? `${path} / ${nodeName}`
        : nodeName;


    const reason =
      getGarbageReason(
        node
      );


    if (reason) {
      result.garbage++;


      let id = "";

      try {
        id = node.id;
      } catch (_) {}


      result.garbageItems.push({
        id,

        name:
          nodeName,

        type:
          safeNodeType(node) ||
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


      if (
        needsBake(node)
      ) {
        result.bakeCandidates++;
      }
    }


    if (
      safeNodeType(node) ===
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
      safeNodeType(node) ===
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
            segment => {
              return (
                !segment.fontName ||
                segment.fontName ===
                  figma.mixed ||
                segment.fontName.family !==
                  "Inter"
              );
            }
          );


        if (nonInter) {
          result.nonInterText++;
        }

      } catch (_) {
        result.nonInterText++;
      }
    }


    if (
      isIconType(node)
    ) {
      result.icons++;
    }


    if (
      safeNodeType(node) ===
      "LINE"
    ) {
      result.lines++;
    }


    for (
      const child of
      getChildrenSnapshot(node)
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
   UI MESSAGE
========================================================= */

figma.ui.onmessage =
async msg => {


  /* =====================================================
     SELECT LAYER
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
          isNodeAlive(node)
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
`지원하지 않는 최상위 Layer가 포함되어 있습니다.

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
            safeNodeName(
              root
            ),

          rootType:
            safeNodeType(
              root
            ),

          willConvertToFrame:
            safeNodeType(root) !==
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
    approvedGarbageOriginalIds =
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


    /*
     * 과거 실행에서 남아있는 TEMP가 있다면
     * 먼저 정리.
     */
    removeTemporaryRoots();


    try {
      if (
        convertFontToInter
      ) {
        await loadInterStyle(
          "Regular"
        );
      }


      const resultRoots =
        [];


      const total = {
        screens:
          selection.length,

        committed:
          0,

        rolledBack:
          0,

        detachedInstances:
          0,

        removedGarbage:
          0,

        protectedGarbage:
          0,

        removedContainers:
          0,

        movedLayers:
          0,

        visualShells:
          0,

        bakedAreas:
          0,

        preservedAreas:
          0,

        convertedTexts:
          0,

        convertedFontSegments:
          0,

        failedFontConversions:
          0,

        finalLayers:
          0
      };


      for (
        const original of
        selection
      ) {
        if (
          !isNodeAlive(original)
        ) {
          continue;
        }


        const cleanResult =
          await cleanWithProtection(
            original
          );


        if (
          cleanResult.root &&
          isNodeAlive(
            cleanResult.root
          )
        ) {
          resultRoots.push(
            cleanResult.root
          );
        }


        if (
          cleanResult.success
        ) {
          total.committed++;

        } else {
          total.rolledBack++;


          console.warn(
            "Rollback:",
            safeNodeName(original),
            cleanResult.reason
          );
        }


        for (
          const key of
          Object.keys(
            cleanResult.stats
          )
        ) {
          if (
            key in total
          ) {
            total[key] +=
              cleanResult.stats[key];
          }
        }
      }


      /*
       * 최종 TEMP Cleanup
       */
      removeTemporaryRoots();


      const aliveResultRoots =
        resultRoots.filter(
          root =>
            isNodeAlive(root)
        );


      if (
        aliveResultRoots.length >
        0
      ) {
        figma.currentPage.selection =
          aliveResultRoots;


        figma.viewport
          .scrollAndZoomIntoView(
            aliveResultRoots
          );
      }


      figma.ui.postMessage({
        type:
          "complete",

        result:
          total
      });


      if (
        total.rolledBack >
        0
      ) {
        figma.notify(
          `${total.rolledBack}개 Screen은 화면 보존을 위해 Rollback되었습니다.`
        );

      } else {
        figma.notify(
          "Cleanup 완료 · Visual Verification PASS"
        );
      }


    } catch (error) {
      /*
       * 어떤 상황에서도
       * 임시 복제본 남기지 않음.
       */
      removeTemporaryRoots();


      console.error(
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
