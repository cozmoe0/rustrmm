// Renders /api/openapi.json without third-party code (served from 'self' for the CSP).
(function () {
  "use strict";
  var METHODS = ["get", "post", "put", "patch", "delete"];
  var spec = null;

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "text") e.textContent = attrs[k];
        else e.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return e;
  }

  function resolve(schema) {
    var seen = 0;
    while (schema && schema.$ref && seen < 20) {
      var name = schema.$ref.split("/").pop();
      schema = (spec.components && spec.components.schemas && spec.components.schemas[name]) || {};
      seen++;
    }
    return schema || {};
  }

  function typeName(schema) {
    if (!schema) return "any";
    if (schema.$ref) return schema.$ref.split("/").pop();
    if (schema.oneOf) return schema.oneOf.map(typeName).join(" | ");
    if (schema.allOf) return schema.allOf.map(typeName).join(" & ");
    var t = schema.type;
    if (Array.isArray(t)) t = t.filter(function (x) { return x !== "null"; }).join(" | ") + (schema.type.indexOf("null") >= 0 ? "?" : "");
    if (t === "array") return typeName(schema.items) + "[]";
    return t || "any";
  }

  function schemaTable(schema) {
    var s = resolve(schema);
    if (s.oneOf) {
      var wrap = el("div");
      s.oneOf.forEach(function (variant) {
        var v = resolve(variant);
        var kind = v.properties && v.properties.kind && v.properties.kind.enum ? v.properties.kind.enum[0] : typeName(variant);
        wrap.appendChild(el("div", { class: "s", text: "Variant " + kind }));
        wrap.appendChild(schemaTable(variant));
      });
      return wrap;
    }
    if (s.type === "array") {
      return el("div", null, [el("div", { class: "s", text: "Array of " + typeName(s.items) }), schemaTable(s.items)]);
    }
    if (!s.properties) return el("div", { class: "s", text: typeName(schema) });
    var required = s.required || [];
    var rows = Object.keys(s.properties).map(function (name) {
      var p = s.properties[name];
      return el("tr", null, [
        el("td", null, [el("code", { text: name + (required.indexOf(name) >= 0 ? "" : "?") })]),
        el("td", null, [el("code", { text: typeName(p) })]),
        el("td", { text: p.description || "" })
      ]);
    });
    return el("table", null, [el("tr", null, [el("th", { text: "Field" }), el("th", { text: "Type" }), el("th", { text: "Description" })])].concat(rows));
  }

  function operation(path, method, op) {
    var body = el("div", { class: "body" });
    if (op.description) body.appendChild(el("p", { text: op.description }));
    if (op.security && op.security.length === 1 && Object.keys(op.security[0]).length === 0) {
      body.appendChild(el("p", { class: "lock", text: "Public: no authentication." }));
    }
    var params = op.parameters || [];
    if (params.length) {
      body.appendChild(el("h4", { text: "Parameters" }));
      body.appendChild(el("table", null, [el("tr", null, [el("th", { text: "Name" }), el("th", { text: "In" }), el("th", { text: "Type" }), el("th", { text: "Description" })])].concat(params.map(function (p) {
        return el("tr", null, [el("td", null, [el("code", { text: p.name + (p.required ? "" : "?") })]), el("td", { text: p.in }), el("td", null, [el("code", { text: typeName(p.schema) })]), el("td", { text: p.description || "" })]);
      }))));
    }
    if (op.requestBody) {
      body.appendChild(el("h4", { text: "Request body" }));
      var content = op.requestBody.content || {};
      Object.keys(content).forEach(function (ct) {
        body.appendChild(el("div", { class: "s", text: ct + (op.requestBody.description ? " — " + op.requestBody.description : "") }));
        if (content[ct].schema) body.appendChild(schemaTable(content[ct].schema));
      });
    }
    var responses = op.responses || {};
    body.appendChild(el("h4", { text: "Responses" }));
    Object.keys(responses).forEach(function (status) {
      var r = responses[status];
      body.appendChild(el("div", null, [el("code", { text: status }), " " + (r.description || "")]));
      var content = r.content || {};
      Object.keys(content).forEach(function (ct) {
        if (content[ct].schema) body.appendChild(schemaTable(content[ct].schema));
      });
    });
    var d = el("details", { "data-search": (method + " " + path + " " + (op.summary || "") + " " + (op.tags || []).join(" ")).toLowerCase() }, [
      el("summary", null, [el("span", { class: "m " + method, text: method }), el("span", { class: "p", text: path }), el("span", { class: "s", text: op.summary || "" })]),
      body
    ]);
    return d;
  }

  function render() {
    var byTag = {};
    Object.keys(spec.paths).sort().forEach(function (path) {
      var item = spec.paths[path];
      METHODS.forEach(function (m) {
        if (!item[m]) return;
        var tag = (item[m].tags && item[m].tags[0]) || "Other";
        (byTag[tag] = byTag[tag] || []).push([path, m, item[m]]);
      });
    });
    var main = document.getElementById("main");
    var nav = document.getElementById("nav");
    main.textContent = "";
    nav.textContent = "";
    if (spec.info && spec.info.description) main.appendChild(el("p", { class: "s", text: spec.info.description }));
    Object.keys(byTag).sort().forEach(function (tag, i) {
      var id = "tag-" + i;
      nav.appendChild(el("a", { href: "#" + id, text: tag + " (" + byTag[tag].length + ")" }));
      var section = el("section", { id: id }, [el("h2", { text: tag })]);
      byTag[tag].forEach(function (e) { section.appendChild(operation(e[0], e[1], e[2])); });
      main.appendChild(section);
    });
  }

  function filter() {
    var q = document.getElementById("q").value.trim().toLowerCase();
    document.querySelectorAll("details").forEach(function (d) {
      d.style.display = !q || d.getAttribute("data-search").indexOf(q) >= 0 ? "" : "none";
    });
    document.querySelectorAll("section").forEach(function (s) {
      var any = Array.prototype.some.call(s.querySelectorAll("details"), function (d) { return d.style.display !== "none"; });
      s.style.display = any ? "" : "none";
    });
  }

  fetch("/api/openapi.json", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (json) { spec = json; render(); })
    .catch(function (e) { document.getElementById("main").textContent = "Could not load the API description: " + e; });
  document.getElementById("q").addEventListener("input", filter);
})();
