//! Markdown → HTML for e-mail. Raw HTML in the source is shown as text (never rendered), and
//! the generated HTML is sanitised again with ammonia, so the server never emits script,
//! event handlers or `javascript:` URLs.

use pulldown_cmark::{Event, Options, Parser, html};

/// Renders Markdown to sanitised HTML.
pub fn to_html(markdown: &str) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    let parser = Parser::new_ext(markdown, options).map(|event| match event {
        // Raw HTML becomes literal text.
        Event::Html(text) | Event::InlineHtml(text) => Event::Text(text),
        other => other,
    });
    let mut rendered = String::with_capacity(markdown.len() * 3 / 2 + 16);
    html::push_html(&mut rendered, parser);
    sanitize(&rendered)
}

/// Sanitises an HTML fragment (allow-listed tags and attributes; http, https and mailto links).
pub fn sanitize(html: &str) -> String {
    ammonia::Builder::default()
        .url_schemes(["http", "https", "mailto"].into_iter().collect())
        .link_rel(Some("noopener noreferrer nofollow"))
        .clean(html)
        .to_string()
}

/// Escapes text for HTML.
pub fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_renders_basic_formatting() {
        let html = to_html("**Bold** and _it_\n\n- one\n- two\n\n[site](https://example.com)");
        assert!(html.contains("<strong>Bold</strong>"), "{html}");
        assert!(html.contains("<em>it</em>"));
        assert!(html.contains("<li>one</li>"));
        assert!(html.contains("href=\"https://example.com\""));
        assert!(html.contains("rel=\"noopener noreferrer nofollow\""));
    }

    #[test]
    fn scripts_handlers_and_javascript_urls_are_removed() {
        let html = to_html(
            "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1))\n\n<a href=\"javascript:alert(2)\">x</a>",
        );
        assert!(!html.contains("<script"), "{html}");
        assert!(!html.contains("<img"), "{html}");
        // No live element carries a javascript: URL; the raw-HTML line is inert text.
        assert!(
            !html.to_lowercase().contains("<a href=\"javascript"),
            "{html}"
        );
        assert!(
            html.contains("<a rel=\"noopener noreferrer nofollow\">click</a>"),
            "{html}"
        );
        assert!(html.contains("&lt;a href="), "{html}");
        // Raw HTML is shown as text, escaped.
        assert!(html.contains("&lt;script&gt;"), "{html}");

        let cleaned = sanitize(
            "<p onclick=\"x()\">hi</p><img src=\"https://e.test/a.png\" onerror=\"alert(1)\"><a href=\"javascript:alert(1)\">j</a><style>p{}</style><iframe src=\"https://e.test\"></iframe>",
        );
        assert!(!cleaned.contains("onclick"), "{cleaned}");
        assert!(!cleaned.contains("onerror"), "{cleaned}");
        assert!(!cleaned.contains("javascript"), "{cleaned}");
        assert!(!cleaned.contains("<style"), "{cleaned}");
        assert!(!cleaned.contains("<iframe"), "{cleaned}");
        assert!(cleaned.contains("<p>hi</p>"));
        assert_eq!(escape("<a href='x'>&"), "&lt;a href=&#39;x&#39;&gt;&amp;");
    }
}
