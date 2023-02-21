// Parse a GC heap log and output a JS program to recreate the structure of
// that heap.
//
// For every node in the heap graph ouptut an expression to create a GC thing
// (where appropriate). Then output a line for every edge to connect the
// graph. Finally output two arrays of roots.

// todo: create actual scripts rather than faking them with objects?

function main(path) {
  let text = os.file.readFile(path);
  parseGCLog(text);

  markReferencedNodes();

  print("(() => {")
  outputNodes();
  outputEdges();
  outputRoots();
  print("})();")
}

let blackRoots = [];
let grayRoots = [];
let nodes = [];
let addressToIdMap = new Map();
let edgeNameToIdMap = new Map();
let edgeNameCount = 0;

const StringKind = 1;        // Handled.
const ObjectKind = 2;        // Handled.
const SymbolKind = 3;        // Handled.
const JitcodeKind = 4;       // Treated as objects.
const ScriptKind = 5;        // Treated as objects (could improve).
const ShapeKind = 6;         // Handled as part of object handling.
const BaseShapeKind = 7;     // Handled as part of object handling.
const GetterSetterKind = 8;  // Treated as objects.
const PropMapKind = 9;       // Handled as part of object handling.
const ScopeKind = 10;        // Treated as objects.
const RegExpSharedKind = 11; // Treated as objects.

function parseGCLog(text) {
  let node;
  let weakMapEntries = [];

  let section;

  for (let match of matchLines(text)) {
    let line = match[0];

    if (line === "# Roots.") {
      section = "roots";
    } else if (line === "# Weak maps.") {
      section = "weakmaps";
    } else if (line === "==========") {
      section = "main";
    } else if (line[0] === "#") {
      continue;
    } else if (line === "{") {
      // Ignore extra JSON data after end of log.
      break;
    } else {
      let words = line.split(" ");

      if (section === "roots") {
        let addr = parseAddr(words[0]);
        let color = parseGCLogColor(words[1]);
        let name = words.slice(2).join(" ");
        createRoot(addr, color, name);
      } else if (section === "weakmaps") {
        // todo: handle weakmaps
      } else if (section === "main") {
        if (words[0] !== ">") {
          let addr = parseAddr(words[0]);
          let color = parseGCLogColor(words[1]);
          let name = words[2];
          let details = words.slice(3).join(" ");
          let kind = getNodeKind(name, details);
          node = createNode(addr, color, kind, details);
        } else {
          if (!node) {
            throw "Unexpected >";
          }
          let addr = parseAddr(words[1]);
          let name = words.slice(3).join(" ");
          createEdge(node, name, addr);
        }
      } else {
        throw "Bad section: " + section;
      }
    }
  }

  // todo: process weak map entries

  return nodes;
}

function matchLines(text) {
  return text.matchAll(/[^\n]+/g);
}

function parseAddr(string) {
  if (!string.startsWith("0x")) {
    throw "Expected address: " + string;
  }
  let addr = parseInt(string.substr(2), 16);
  if (Number.isNaN(addr)) {
    throw "Can't parse address: " + string;
  }
  return addr;
}

function formatAddr(addr) {
  return "0x" + addr.toString(16);
}

function parseGCLogColor(string) {
  if (string === "B") {
    return "black";
  }

  if (string === "G") {
    return "gray";
  }

  throw "Unrecognised GC log color: " + string;
}

function getNodeKind(name, details) {
  if (name === "string" || name === "substring") {
    return StringKind;
  } else if (name === "symbol") {
    return SymbolKind;
  } else if (name === "jitcode") {
    return JitcodeKind;
  } else if (name === "script") {
    return ScriptKind;
  } else if (name === "shape") {
    return ShapeKind;
  } else if (name === "base_shape") {
    return BaseShapeKind;
  } else if (name === "getter_setter") {
    return GetterSetterKind;
  } else if (name === "prop_map") {
    return PropMapKind;
  } else if (name === "scope") {
    return ScopeKind;
  } else if (name === "reg_exp_shared") {
    return RegExpSharedKind;
  } else if (name === "Function" || details.endsWith("<unknown object>")) {
    return ObjectKind;
  } else {
    throw `unknown kind: ${name} ${details}`;
    return name;
  }
}

function createRoot(addr, color, name) {
  let root = {address: addr,
              color,
              name};

  if (color === "black") {
    blackRoots.push(root);
  } else if (color === "gray") {
    grayRoots.push(root);
  } else {
    throw "Bad color";
  }

  return root;
}

function createNode(addr, color, kind, details) {
  if (addressToIdMap.has(addr)) {
    throw "Duplicate address";
  }

  let node = {id: nodes.length,
              address: addr,
              color,
              kind,
              details,
              outgoingEdges: [],
              outgoingEdgeNames: [],
              marked: false};
  nodes.push(node);

  addressToIdMap.set(addr, node.id);

  return node;
}

const elementsRegExp = /^objectElements\[(\d+)\]$/;

function createEdge(node, name, addr) {
  let match = name.match(elementsRegExp);
  if (match) {
    let index = parseInt(match[1]);
    if (Number.isNaN(index)) {
      throw `Error parsing element index in ${name}`;
    }
    name = index;
  } else {
    let id = edgeNameToIdMap.get(name);
    if (id === undefined) {
      id = edgeNameCount++;
      edgeNameToIdMap.set(name, id);
    }
    name = `e${id}`;
  }

  node.outgoingEdges.push(addr);
  node.outgoingEdgeNames.push(name);
}

function markReferencedNodes() {
  // Transitively mark referenced nodes. Heap dumps always contain nodes for all
  // permanent atoms even though most are never referenced and we don't want
  // to output these. This also removes any other garbage that may be present.

  let worklist = [];

  for (let roots of [blackRoots, grayRoots]) {
    for (let root of roots) {
      if (!addressToIdMap.has(root.address)) {
        throw "Unknown root target";
      }

      let target = nodes[addressToIdMap.get(root.address)];
      if (!target.marked) {
        target.marked = true;
        worklist.push(target);
      }
    }
  }

  while (worklist.length) {
    let node = worklist.pop();
    if (!includeNode(node)) {
      continue;
    }

    for (let i = 0; i < node.outgoingEdges.length; i++) {
      let addr = node.outgoingEdges[i];
      if (!addressToIdMap.has(addr)) {
        throw "Unknown edge target";
      }

      let target = nodes[addressToIdMap.get(addr)];
      if (!target.marked) {
        target.marked = true;
        worklist.push(target);
      }
    }
  }
}

function outputNodes() {
  for (let node of nodes) {
    if (!node.marked) {
      continue;
    }

    let name = nodeName(node);
    if (node.kind === StringKind) {
      // Don't use real string contents, just make a unique string.
      print(`let ${name}="${node.id}";`);
    } else if (node.kind === SymbolKind) {
      print(`const ${name}=Symbol();`);
    } else if (includeNode(node)) {
      // Use objects for all other kinds.
      let names = [];
      for (let i = 0; i < node.outgoingEdges.length; i++) {
        let addr = node.outgoingEdges[i];
        let edgeName = node.outgoingEdgeNames[i];
        if (!addressToIdMap.has(addr)) {
          throw "Unknown edge target";
        }

        let target = nodes[addressToIdMap.get(addr)];
        if (!includeEdgeTo(target)) {
          continue;
        }

        if (typeof edgeName === "string") {
          names.push(`${edgeName}:0`);
        }
      }
      print(`let ${name}={${names.join(",")}};`);
    }
  }
}

function outputEdges() {
  print();

  for (let node of nodes) {
    if (!node.marked) {
      continue;
    }

    for (let i = 0; i < node.outgoingEdges.length; i++) {
      let addr = node.outgoingEdges[i];
      let name = node.outgoingEdgeNames[i];
      if (!addressToIdMap.has(addr)) {
        throw "Unknown edge target";
      }

      let target = nodes[addressToIdMap.get(addr)];
      if (!includeEdgeTo(target)) {
        continue;
      }

      if (typeof name === "string") {
        print(`${nodeName(node)}.${name}=${nodeName(target)};`);
      } else {
        if (typeof name !== "number") {
          throw "Unexpected edge name";
        }
        print(`${nodeName(node)}[${name}]=${nodeName(target)};`);
      }
    }
  }
}

function includeNode(node) {
  return node.kind === StringKind ||
         node.kind === SymbolKind ||
         node.kind === ObjectKind ||
         node.kind === ScriptKind ||
         node.kind === JitcodeKind ||
         node.kind === GetterSetterKind ||
         node.kind === ScopeKind ||
         node.kind === RegExpSharedKind;
}

function includeEdgeTo(target) {
  return includeNode(target);
}

function outputRoots() {
  print();

  outputRootArray("black", blackRoots);
  outputRootArray("gray", grayRoots);
}

function outputRootArray(color, roots) {
  let i = 0;
  for (let root of roots) {
    if (!addressToIdMap.has(root.address)) {
      throw "Unknown root target";
    }

    let target = nodes[addressToIdMap.get(root.address)];
    if (includeEdgeTo(target)) {
      print(`${color}Root()[${i++}]=${nodeName(target)};`);
    }
  }
}

function nodeName(node) {
  return "n" + node.id;
}

main(...scriptArgs);
