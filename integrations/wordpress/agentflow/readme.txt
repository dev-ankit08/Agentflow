=== AgentFlow Assistant ===
Tags: ai, chatbot, assistant, agents, support
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 0.1.0
License: GPLv2 or later

Add your AgentFlow AI assistant to WordPress as a chat bubble or an inline panel.

== Description ==

AgentFlow lets you build multi-agent AI assistants visually. This plugin embeds a published AgentFlow flow on your site:

* A chat bubble on every page, or an inline panel wherever you place the `[agentflow]` shortcode.
* Logged-in WordPress users can be signed in to the assistant automatically (id, name, email), so flows can greet customers by name and remember them across conversations.

== Installation ==

1. Copy the `agentflow` folder to `wp-content/plugins/` (or zip it and upload it under Plugins → Add New → Upload).
2. Activate **AgentFlow Assistant**.
3. In AgentFlow, open your flow's **Deploy** page:
   * add your site's address (e.g. `https://example.com`) to **Allowed websites**;
   * copy the widget key (the `data-flow` value of the snippet);
   * optionally create an identity secret under **Signed-in users**.
4. In WordPress, go to Settings → AgentFlow and paste the API URL, the widget key and (optionally) the identity secret.

== Shortcode ==

`[agentflow height="600"]` shows the assistant inline at that height (in pixels).

== Notes ==

* The identity secret stays on your server; the browser only receives a signed token that expires after an hour.
* User ids are sent as `wp_<user id>`. Use that id on AgentFlow's Settings → Customer data requests page to view or erase a customer's data.
