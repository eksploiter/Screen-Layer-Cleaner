figma.showUI(__html__, {
  width: 440,
  height: 760,
  themeColors: true
});


/* =========================================================
   SCREEN LAYER CLEANER

   최우선 원칙
   ---------------------------------------------------------
   화면 보존 > 1 Depth > Layer 정리

   즉,
   - 안전하게 풀 수 있는 Frame/Group은 1 Depth로 Flatten
   - Mask / 실제 Clip / Opacity / Blend / Effect 등
     구조 제거 시 화면이 달라질 가능성이 있는 영역은 유지
   - 정말 이동 자체가 불가능한 예외만 screenshot Bake
   - 원본에는 직접 작업하지 않고 Working Copy에서 처리
   - 실패 시 Working Copy 삭제, 원본 유지
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
   STATS
========================================================= */

function createEmptyStats() {
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
   SAFE NODE ACCESS
========================================================= */

function safeNodeType(node) {
  try {
    return node ? node.type : null;
  } catch (_) {
    return null;
  }
}


function safeNodeName(node) {
  try {
    return node ? node.name : "(unknown)";
  } catch (_) {
    return "(deleted node)";
  }
}


function safeNodeId(node) {
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


/*
 * Page 직속 Node도 parent가 존재하므로 true.
 *
 * 삭제된 Node의 parent를 읽다가
 * get_parent 오류가 발생하는 것을 방어한다.
 */
function isNodeAlive(node) {
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


async function resolveNodeById(nodeId) {
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

    return isNodeAlive(node)
      ? node
      : null;

  } catch (_) {
    return null;
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
      "Parent Transform을 읽을 수 없습니다."
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

  let current =
    safeParent(node);

  while (current) {
    if (
      safeNodeType(current) ===
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
   STRUCTURAL PATH
========================================================= */

/*
 * Original과 Working Clone의 Node ID는 달라진다.
 *
 * 따라서 Garbage 승인 대상은:
 *
 * 0/2/1/5
 *
 * 같은 child index path로 대응한다.
 */

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

    const id =
      safeNodeId(node);

    if (id) {
      idToPath.set(
        id,
        path
      );
    }

    pathToNode.set(
      path,
      node
    );


    const children =
      getChildrenSnapshot(node);

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
      fill =>
        fill.type === "IMAGE" &&
        fill.visible !== false
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
    safeNodeType(node) ===
    "SLICE"
  ) {
    return "Slice Layer";
  }


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

    const result = [];


    for (
      const segment of segments
    ) {
      if (
        segment.fontName &&
        segment.fontName !==
          figma.mixed
      ) {
        result.push({
          family:
            segment.fontName.family,

          style:
            segment.fontName.style
        });
      }
    }


    return result;

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


/*
 * Text Layer를 Frame 밖으로 이동할 때도
 * 기존 Font Load가 필요할 수 있다.
 *
 * 따라서 Inter 옵션과 무관하게
 * 원본 Screen의 Font를 먼저 Load한다.
 */
async function preloadFonts(
  root
) {
  const pathMap =
    buildNodePathMap(
      root
    );

  const fontMap =
    new Map();

  const pathFonts =
    new Map();


  function walk(node) {
    if (!isNodeAlive(node)) {
      return;
    }


    if (
      safeNodeType(node) ===
      "TEXT"
    ) {
      const id =
        safeNodeId(node);

      const path =
        id
          ? pathMap.idToPath.get(
              id
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
        pathFonts.set(
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
      failedFontKeys.add(
        key
      );

      console.warn(
        "Font preload failed:",
        font.family,
        font.style,
        error
      );
    }
  }


  const failedPaths =
    new Set();


  for (
    const [path, keys]
    of pathFonts.entries()
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
    return weight === "Regular"
      ? "Italic"
      : `${weight} Italic`;
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
      safeNodeName(node),
      error
    );

    return 0;
  }
}


/* =========================================================
   MASK / CLIP / VISUAL PROTECTION
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


/*
 * clipsContent가 켜져 있다는 이유만으로
 * Container를 보호하지 않는다.
 *
 * 실제로 Child가 범위를 넘어간 경우만 보호.
 */
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
    const child of
    getChildrenSnapshot(node)
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
 * 제1법칙 핵심.
 *
 * 아래 Container는 해체하지 않는다.
 *
 * screenshot도 우선 사용하지 않는다.
 * Container 자체를 Root 아래로 올리고
 * 내부 구조는 유지한다.
 */
function needsPreserve(node) {
  if (!isContainer(node)) {
    return false;
  }


  /*
   * Detach에 실패해 남은 Instance.
   */
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
  const result = [];


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
      const id =
        safeNodeId(node);

      if (id) {
        result.push({
          id,
          depth
        });
      }
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


  return result;
}


/*
 * Node 객체를 오래 들고 있지 않는다.
 *
 * Instance Detach 뒤 Node reference가 stale 되는
 * 문제를 막기 위해 ID로 재조회한다.
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


    /*
     * 가장 깊은 Instance부터.
     */
    instances.sort(
      (a, b) =>
        b.depth -
        a.depth
    );


    let successCount = 0;


    for (
      const item of instances
    ) {
      const instance =
        await resolveNodeById(
          item.id
        );


      if (
        !instance ||
        safeNodeType(instance) !==
          "INSTANCE"
      ) {
        continue;
      }


      try {
        instance.detachInstance();

        stats.detachedInstances++;

        successCount++;

      } catch (error) {
        /*
         * 실패하면 그대로 둔다.
         *
         * 이후 needsPreserve()가
         * Instance 자체를 보호.
         */
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
      "Root 변환 대상이 존재하지 않습니다."
    );
  }


  const parent =
    safeParent(source);


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


  let width = 1;
  let height = 1;

  try {
    width =
      source.width;

    height =
      source.height;
  } catch (_) {}


  const sourceName =
    safeNodeName(
      source
    );


  const childSnapshots =
    getChildrenSnapshot(
      source
    )
      .map(
        child => ({
          id:
            safeNodeId(child),

          transform:
            safeAbsoluteTransform(
              child
            )
        })
      )
      .filter(
        item =>
          item.id &&
          item.transform
      );


  const frame =
    figma.createFrame();


  frame.setPluginData(
    TEMP_PLUGIN_KEY,
    "true"
  );


  frame.name =
    sourceName;


  /*
   * createFrame 기본 흰 배경 제거.
   */
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


  /*
   * Root는 Page Level Working Copy이므로
   * 여기서는 Child 이동 가능.
   */
  for (
    const item of childSnapshots
  ) {
    const child =
      figma.getNodeById(
        item.id
      );


    if (
      !child ||
      !isNodeAlive(child)
    ) {
      continue;
    }


    try {
      frame.appendChild(
        child
      );


      child.relativeTransform =
        absoluteToRelative(
          item.transform,
          frame
        );

    } catch (error) {
      console.warn(
        "Root child move failed:",
        safeNodeName(child),
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
      "Working Root가 존재하지 않습니다."
    );
  }


  const type =
    safeNodeType(node);


  /*
   * Frame이면 그대로.
   */
  if (
    type === "FRAME"
  ) {
    node.setPluginData(
      TEMP_PLUGIN_KEY,
      "true"
    );

    return node;
  }


  /*
   * Root Instance.
   */
  if (
    type === "INSTANCE"
  ) {
    try {
      const detached =
        node.detachInstance();


      if (
        detached &&
        isNodeAlive(detached)
      ) {
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
      }

    } catch (error) {
      console.warn(
        "Root Instance detach failed:",
        error
      );
    }


    /*
     * Detach 실패 Root Instance를
     * 억지로 child 이동시키는 것은 위험.
     *
     * 전체 Clone을 Frame으로 재구성한다.
     */
    return replaceRootWithFrame(
      node
    );
  }


  /*
   * Component / Group
   */
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


  const name =
    safeNodeName(node)
      .toLowerCase();


  /*
   * 이름이 실제 Screenshot 성격이면 우선.
   */
  if (
    name.includes("screenshot") ||
    name.includes("screen shot") ||
    name.includes("스크린샷")
  ) {
    return true;
  }


  /*
   * Screen 대부분을 차지하는 Image Fill.
   */
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
   CONTAINER VISUAL SHELL
========================================================= */

/*
 * 안전한 Frame을 제거할 때
 * Frame 자체 Fill / Stroke는 Rectangle로 재현한다.
 *
 * Parent Effect 등이 있는 Frame은
 * needsPreserve()에서 이미 걸러진다.
 */

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
   SCREENSHOT FALLBACK
========================================================= */

/*
 * screenshot은 최후의 수단이다.
 *
 * 일반 Mask / Clip은 Preserve Container가 우선.
 * 아래 함수는 이동 자체가 불가능한 예외에만 사용.
 */

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
      "Screenshot fallback export failed:",
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
 * Plan Types
 *
 * garbage
 *   → 승인된 Garbage 삭제
 *
 * leaf
 *   → Root로 직접 이동
 *
 * shell
 *   → 안전 Frame 자체 Visual을 shape로 재현
 *
 * preserve-container
 *   → 화면 보호가 필요한 Container
 *     내부 구조는 건드리지 않고 Container 자체만 Root로
 *
 * preserve-leaf
 *   → Font 등으로 직접 재구성이 위험한 leaf
 */

async function buildFlattenPlan(
  root,
  stats
) {
  const plan = [];


  async function visit(
    node,
    path
  ) {
    if (!isNodeAlive(node)) {
      return;
    }


    const nodeId =
      safeNodeId(node);


    if (!nodeId) {
      return;
    }


    /* -------------------------------------------------
       GARBAGE
    ------------------------------------------------- */

    const garbageReason =
      getGarbageReason(
        node
      );


    if (garbageReason) {
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
        /*
         * 체크 해제한 Garbage는
         * 삭제하지 않는다.
         *
         * Container라면 통째로 Preserve.
         */
        plan.push({
          type:
            isContainer(node)
              ? "preserve-container"
              : "preserve-leaf",

          nodeId,

          transform:
            safeAbsoluteTransform(
              node
            )
        });


        stats.protectedGarbage++;
      }


      return;
    }


    /* -------------------------------------------------
       UNAVAILABLE FONT TEXT
    ------------------------------------------------- */

    if (
      safeNodeType(node) ===
        "TEXT" &&
      unavailableFontPaths.has(
        path
      )
    ) {
      /*
       * 기존 Font를 Load하지 못했다면
       * Text를 이동하면서 Figma가 재계산할 때
       * 오류가 날 수 있다.
       *
       * 우선 Leaf 자체를 Preserve 대상으로 둔다.
       */
      plan.push({
        type:
          "preserve-leaf",

        nodeId,

        transform:
          safeAbsoluteTransform(
            node
          )
      });


      stats.preservedAreas++;

      return;
    }


    /* -------------------------------------------------
       CONTAINER
    ------------------------------------------------- */

    if (
      isContainer(node)
    ) {
      /*
       * Visual을 유지하기 위해
       * 구조 자체가 필요한 Container.
       */
      if (
        needsPreserve(node)
      ) {
        plan.push({
          type:
            "preserve-container",

          nodeId,

          transform:
            safeAbsoluteTransform(
              node
            )
        });


        stats.preservedAreas++;

        return;
      }


      /*
       * 안전한 Frame 자체 Background.
       */
      if (
        hasOwnVisual(node)
      ) {
        const snapshot =
          snapshotContainerVisual(
            node
          );


        if (snapshot) {
          plan.push({
            type:
              "shell",

            snapshot
          });
        }
      }


      /*
       * 안전한 Container만 내부 탐색.
       */
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


    /* -------------------------------------------------
       NORMAL LEAF
    ------------------------------------------------- */

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
   EXECUTE PLAN
========================================================= */

async function moveNodeToRoot(
  node,
  root,
  transform
) {
  if (
    !node ||
    !root ||
    !transform ||
    !isNodeAlive(node) ||
    !isNodeAlive(root)
  ) {
    return false;
  }


  /*
   * 이미 Root 바로 아래면 위치 이동 불필요.
   */
  if (
    safeParent(node) === root
  ) {
    return true;
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


    return true;

  } catch (error) {
    console.warn(
      "Move to Root failed:",
      safeNodeName(node),
      error
    );

    return false;
  }
}


async function fallbackNodeToScreenshot(
  node,
  root,
  stats
) {
  if (
    !node ||
    !isNodeAlive(node)
  ) {
    return false;
  }


  const snapshot =
    await createBakeSnapshot(
      node
    );


  if (!snapshot) {
    return false;
  }


  const screenshot =
    createBakedScreenshot(
      snapshot,
      root
    );


  if (!screenshot) {
    return false;
  }


  stats.bakedAreas++;
  stats.finalLayers++;

  return true;
}


async function executeFlattenPlan(
  root,
  plan,
  stats
) {
  /*
   * stale object 문제를 피하기 위해
   * 원래 Root Child는 ID만 저장.
   */
  const originalChildIds =
    getChildrenSnapshot(root)
      .map(
        child =>
          safeNodeId(child)
      )
      .filter(Boolean);


  /* -----------------------------------------------------
     1. Garbage Delete
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


    if (
      node &&
      safeRemove(node)
    ) {
      stats.removedGarbage++;
    }
  }


  /* -----------------------------------------------------
     2. Result Build
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


    /* -------------------------------------------------
       SHELL
    ------------------------------------------------- */

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


    /* -------------------------------------------------
       PRESERVE CONTAINER
    ------------------------------------------------- */

    if (
      item.type ===
      "preserve-container"
    ) {
      const node =
        await resolveNodeById(
          item.nodeId
        );


      if (!node) {
        continue;
      }


      /*
       * 부모가 또 Instance라면 직접 빼면 안 된다.
       *
       * 하지만 buildFlattenPlan은 가장 상위
       * Preserve Container에서 recursion을 중단하므로
       * 정상적인 경우 여기 들어오지 않는다.
       */
      if (
        isInsideInstance(node)
      ) {
        const baked =
          await fallbackNodeToScreenshot(
            node,
            root,
            stats
          );


        if (!baked) {
          stats.preservedAreas++;
        }

        continue;
      }


      const transform =
        item.transform ||
        safeAbsoluteTransform(
          node
        );


      const moved =
        await moveNodeToRoot(
          node,
          root,
          transform
        );


      if (moved) {
        /*
         * 내부 구조는 유지하지만
         * 해당 Container는 Root 직속이 됨.
         */
        stats.finalLayers++;

      } else {
        /*
         * 정말 이동이 불가능할 때만
         * screenshot fallback.
         */
        const retryNode =
          await resolveNodeById(
            item.nodeId
          );


        const baked =
          await fallbackNodeToScreenshot(
            retryNode,
            root,
            stats
          );


        if (!baked) {
          stats.preservedAreas++;
        }
      }


      continue;
    }


    /* -------------------------------------------------
       PRESERVE LEAF
    ------------------------------------------------- */

    if (
      item.type ===
      "preserve-leaf"
    ) {
      const node =
        await resolveNodeById(
          item.nodeId
        );


      if (!node) {
        continue;
      }


      /*
       * Font Load 실패 Text 등.
       *
       * 직접 이동을 먼저 시도.
       * 실패할 때만 screenshot.
       */
      const transform =
        item.transform ||
        safeAbsoluteTransform(
          node
        );


      const moved =
        await moveNodeToRoot(
          node,
          root,
          transform
        );


      if (moved) {
        normalizeLayerName(
          node,
          root
        );

        stats.finalLayers++;

      } else {
        const retryNode =
          await resolveNodeById(
            item.nodeId
          );


        const baked =
          await fallbackNodeToScreenshot(
            retryNode,
            root,
            stats
          );


        if (!baked) {
          stats.preservedAreas++;
        }
      }


      continue;
    }


    /* -------------------------------------------------
       NORMAL LEAF
    ------------------------------------------------- */

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


      /*
       * 아직 Instance 내부에 있다면
       * 직접 재부모화하지 않는다.
       */
      if (
        isInsideInstance(node)
      ) {
        const baked =
          await fallbackNodeToScreenshot(
            node,
            root,
            stats
          );


        if (!baked) {
          stats.preservedAreas++;
        }


        continue;
      }


      const moved =
        await moveNodeToRoot(
          node,
          root,
          item.transform
        );


      if (!moved) {
        const retryNode =
          await resolveNodeById(
            item.nodeId
          );


        const baked =
          await fallbackNodeToScreenshot(
            retryNode,
            root,
            stats
          );


        if (!baked) {
          stats.preservedAreas++;
        }


        continue;
      }


      /*
       * Font Family → Inter 옵션.
       *
       * 사용자가 명시적으로 ON 했을 때만.
       */
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
    }
  }


  /* -----------------------------------------------------
     3. Empty / Old Containers 제거
  ----------------------------------------------------- */

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


    /*
     * Root 직속 결과로 그대로 남아야 하는
     * Preserve Container인지 확인.
     */
    const preserve =
      plan.some(
        item =>
          item.type ===
            "preserve-container" &&
          item.nodeId ===
            childId
      );


    const preserveLeaf =
      plan.some(
        item =>
          item.type ===
            "preserve-leaf" &&
          item.nodeId ===
            childId
      );


    const leaf =
      plan.some(
        item =>
          item.type ===
            "leaf" &&
          item.nodeId ===
            childId
      );


    if (
      preserve ||
      preserveLeaf ||
      leaf
    ) {
      continue;
    }


    /*
     * 기존 Container 내부 Child들이
     * 모두 Root로 이동했으면 Container만 제거.
     */
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
   SAFE LAYER ORDER
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


/*
 * 하나라도 겹치는 Layer가 있으면
 * Layer 순서 변경 자체를 하지 않는다.
 *
 * Layer Panel 순서 = Z-order이므로
 * 화면 보호가 우선.
 */
function screenHasOverlappingLayers(
  root
) {
  const children =
    getChildrenSnapshot(
      root
    );


  const items =
    children.map(
      node => ({
        node,
        bounds:
          getBounds(node)
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
        return true;
      }
    }
  }


  return false;
}


/*
 * 오직 모든 Root Child가 서로 안 겹칠 때만:
 *
 * 화면상 위 → 아래
 * 같은 줄 → 좌 → 우
 *
 * Layer Panel에서도 같은 읽기 순서가 되도록 구성.
 */
function sortLayersSafely(root) {
  if (
    !hasChildren(root)
  ) {
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


  if (
    screenHasOverlappingLayers(
      root
    )
  ) {
    console.log(
      "Layer order preserved: overlapping layers detected."
    );

    return;
  }


  const sorted =
    children
      .map(
        (node, originalIndex) => ({
          node,

          bounds:
            getBounds(node),

          originalIndex
        })
      )
      .sort(
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
           * 같은 라인 → 좌 → 우.
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
              Math.abs(
                xDiff
              ) > 0.1
            ) {
              return xDiff;
            }
          }


          /*
           * 위 → 아래.
           */
          const yDiff =
            a.bounds.y -
            b.bounds.y;


          if (
            Math.abs(
              yDiff
            ) > 0.1
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
   * Figma children 순서는
   * Layer Panel에서 역순으로 표시되므로 reverse.
   */
  const figmaOrder =
    [...sorted]
      .reverse();


  for (
    let i = 0;
    i < figmaOrder.length;
    i++
  ) {
    const node =
      figmaOrder[i].node;


    if (!isNodeAlive(node)) {
      continue;
    }


    try {
      root.insertChild(
        i,
        node
      );

    } catch (error) {
      console.warn(
        "Layer sorting stopped:",
        safeNodeName(node),
        error
      );

      return;
    }
  }
}


/* =========================================================
   TEMP WORKING COPY
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


function removeTemporaryRoots() {
  const nodes =
    getTemporaryRoots();


  /*
   * Child Temp를 먼저 지우면 stale 문제가 생길 수 있다.
   * Page에 가장 가까운 Temp Root만 제거한다.
   */
  for (
    const node of nodes
  ) {
    if (!isNodeAlive(node)) {
      continue;
    }


    let parent =
      safeParent(node);

    let tempAncestor =
      false;


    while (
      parent &&
      safeNodeType(parent) !==
        "PAGE"
    ) {
      try {
        if (
          parent.getPluginData &&
          parent.getPluginData(
            TEMP_PLUGIN_KEY
          ) === "true"
        ) {
          tempAncestor =
            true;

          break;
        }
      } catch (_) {}


      parent =
        safeParent(parent);
    }


    if (
      tempAncestor
    ) {
      continue;
    }


    safeRemove(
      node
    );
  }
}


/*
 * Working Copy는 항상 Page 바로 아래에 생성.
 *
 * Instance ancestry를 완전히 끊는다.
 */
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


  /*
   * 원본과 겹치지 않도록 멀리 배치.
   *
   * Cleanup 완료 후 원래 위치로 Commit한다.
   */
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
      clone.x = 100000;
      clone.y = 100000;
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
  const stats =
    createEmptyStats();


  /*
   * 1.
   * Instance는 최대한 Detach.
   *
   * 실패한 Instance는 이후 Preserve.
   */
  await detachAllInstances(
    root,
    stats
  );


  /*
   * 2.
   * Flatten Plan.
   */
  const plan =
    await buildFlattenPlan(
      root,
      stats
    );


  /*
   * 3.
   * 최상위 Root가 Auto Layout이면
   * Root 자체만 Layout 해제.
   *
   * Child 위치는 Plan에 absoluteTransform으로
   * 저장되어 있다.
   */
  try {
    if (
      root.layoutMode !==
      "NONE"
    ) {
      root.layoutMode =
        "NONE";
    }
  } catch (_) {}


  /*
   * 4.
   * Plan 실행.
   */
  await executeFlattenPlan(
    root,
    plan,
    stats
  );


  /*
   * 5.
   * Layer Order.
   *
   * 겹친 요소가 있으면 Z-order 보호를 위해 Skip.
   */
  sortLayersSafely(
    root
  );


  return stats;
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
      "Commit 대상 Screen이 존재하지 않습니다."
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


  /*
   * 원본 자체가 또 다른 Instance 내부인 경우
   * 같은 위치에 Frame을 삽입할 수 없다.
   *
   * 이 경우는 원본 보호.
   */
  if (
    safeNodeType(parent) ===
      "INSTANCE" ||
    isInsideInstance(parent)
  ) {
    throw new Error(
      "선택한 Screen 자체가 다른 Instance 내부에 있습니다. 가장 바깥쪽 Screen을 선택해주세요."
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
      "Original Screen 위치를 읽을 수 없습니다."
    );
  }


  /*
   * Commit 전 TEMP 표시 제거.
   */
  working.setPluginData(
    TEMP_PLUGIN_KEY,
    ""
  );


  /*
   * 원래 sibling 위치로.
   */
  parent.insertChild(
    Math.max(
      index,
      0
    ),
    working
  );


  /*
   * Working Copy는 멀리 떨어져 있었으므로
   * 원본 Absolute Transform으로 복원.
   */
  working.relativeTransform =
    absoluteToRelative(
      originalTransform,
      parent
    );


  /*
   * Clean 결과가 정상적으로 들어간 뒤
   * 원본 제거.
   */
  if (
    !safeRemove(original)
  ) {
    throw new Error(
      "Original Screen 교체 중 오류가 발생했습니다."
    );
  }


  return working;
}


/* =========================================================
   TRANSACTION
========================================================= */

/*
 * 이전처럼 PNG Byte 100% 비교는 하지 않는다.
 *
 * 같은 화면이어도 Rasterization / PNG encoding 차이로
 * 정상 결과가 Rollback되는 문제가 있었기 때문이다.
 *
 * 대신 화면을 변경시킬 가능성이 있는 구조 자체를
 * Preserve하는 방식으로 바꿨다.
 */

async function cleanWithProtection(
  original
) {
  let working = null;

  let committed = false;

  let stats =
    createEmptyStats();


  try {
    /* -------------------------------------------------
       1. Font Preload
    ------------------------------------------------- */

    const fontResult =
      await preloadFonts(
        original
      );


    unavailableFontPaths =
      fontResult.failedPaths;


    /* -------------------------------------------------
       2. Garbage 승인 Path
    ------------------------------------------------- */

    approvedGarbagePaths =
      buildApprovedGarbagePaths(
        original
      );


    /* -------------------------------------------------
       3. Working Copy
    ------------------------------------------------- */

    working =
      createPageWorkingCopy(
        original
      );


    /* -------------------------------------------------
       4. Root → Frame
    ------------------------------------------------- */

    working =
      normalizeRootToFrame(
        working
      );


    if (
      !working ||
      !isNodeAlive(working)
    ) {
      throw new Error(
        "Screen Frame 변환에 실패했습니다."
      );
    }


    working.setPluginData(
      TEMP_PLUGIN_KEY,
      "true"
    );


    /* -------------------------------------------------
       5. Cleanup
    ------------------------------------------------- */

    stats =
      await cleanWorkingRoot(
        working
      );


    /* -------------------------------------------------
       6. Commit
    ------------------------------------------------- */

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
      "Cleanup transaction failed:",
      error
    );


    return {
      success:
        false,

      root:
        original,

      stats,

      reason:
        error &&
        error.message
          ? error.message
          : String(error)
    };


  } finally {
    /*
     * 성공했다면 committed Root는
     * TEMP flag가 제거되어 있으므로 삭제되지 않는다.
     *
     * 실패했다면 Working Copy를 전부 제거.
     */
    removeTemporaryRoots();


    if (!committed) {
      working = null;
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
     * 기존 UI 호환을 위해 이름은
     * bakeCandidates 유지.
     *
     * 실제 의미는 Visual 보호가 필요한 Container 수.
     */
    bakeCandidates: 0
  };


  function walk(
    node,
    displayPath
  ) {
    if (!isNodeAlive(node)) {
      return;
    }


    result.total++;


    const name =
      safeNodeName(
        node
      );


    const currentPath =
      displayPath
        ? `${displayPath} / ${name}`
        : name;


    /* ---------------------------------------------
       Garbage
    --------------------------------------------- */

    const reason =
      getGarbageReason(
        node
      );


    if (reason) {
      result.garbage++;


      result.garbageItems.push({
        id:
          safeNodeId(node) || "",

        name,

        type:
          safeNodeType(node) ||
          "UNKNOWN",

        reason,

        path:
          currentPath
      });
    }


    /* ---------------------------------------------
       Container
    --------------------------------------------- */

    if (
      node !== root &&
      isContainer(node)
    ) {
      result.containers++;


      if (
        needsPreserve(node)
      ) {
        result.bakeCandidates++;
      }
    }


    /* ---------------------------------------------
       Instance
    --------------------------------------------- */

    if (
      safeNodeType(node) ===
      "INSTANCE"
    ) {
      result.instances++;
    }


    /* ---------------------------------------------
       Auto Layout
    --------------------------------------------- */

    try {
      if (
        "layoutMode" in node &&
        node.layoutMode !==
          "NONE"
      ) {
        result.autoLayouts++;
      }
    } catch (_) {}


    /* ---------------------------------------------
       Mask
    --------------------------------------------- */

    try {
      if (
        "isMask" in node &&
        node.isMask === true
      ) {
        result.masks++;
      }
    } catch (_) {}


    /* ---------------------------------------------
       Actual Clip
    --------------------------------------------- */

    if (
      node !== root &&
      actuallyClipsChildren(
        node
      )
    ) {
      result.clips++;
    }


    /* ---------------------------------------------
       Text
    --------------------------------------------- */

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


    /* ---------------------------------------------
       Icon
    --------------------------------------------- */

    if (
      isIconType(node)
    ) {
      result.icons++;
    }


    /* ---------------------------------------------
       Line
    --------------------------------------------- */

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

    } catch (error) {
      console.warn(
        "Layer selection failed:",
        error
      );
    }


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
     * 과거 실패한 Working Copy가
     * 혹시 남아있다면 실행 전에 제거.
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


      const resultRoots = [];


      /*
       * 기존 UI와 호환하기 위해
       * committed / rolledBack 유지.
       *
       * 이제 rolledBack은 PNG 차이가 아니라
       * 실제 처리 오류가 발생한 경우만 의미한다.
       */
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
          !isNodeAlive(
            original
          )
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
            "Cleanup rollback:",
            safeNodeName(
              original
            ),
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
       * Temp 최종 정리.
       */
      removeTemporaryRoots();


      const aliveRoots =
        resultRoots.filter(
          root =>
            isNodeAlive(root)
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
          `${total.rolledBack}개 Screen은 처리 중 오류로 원본을 유지했습니다.`
        );

      } else if (
        total.preservedAreas > 0
      ) {
        figma.notify(
          `Cleanup 완료 · 화면 보호를 위해 ${total.preservedAreas}개 영역의 내부 구조를 유지했습니다.`
        );

      } else {
        figma.notify(
          "Cleanup 완료"
        );
      }


    } catch (error) {
      /*
       * 어떤 오류가 발생해도
       * 복사본은 남기지 않는다.
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
