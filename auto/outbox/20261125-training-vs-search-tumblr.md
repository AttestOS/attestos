# Blocking training does not have to block search

channel: tumblr
kind: value

When deciding what AI crawlers can access your content, it's essential to distinguish between search, training, and live fetchers. Search crawlers like Googlebot help users find your site, while training crawlers harvest data for machine learning models. Live fetchers, on the other hand, retrieve content in real-time for services like instant answers.

To manage these crawlers, review your robots.txt rules and consider each category separately. Don't block or allow based on the company, but rather the crawler's purpose. For instance, you might allow search crawlers while restricting training crawlers.

Verifying crawlers by their published IP ranges can also help ensure only authorized bots access your site. Some services, like paid crawling, use HTTP 402 to charge for access, while others utilize agent keys or Private Access Tokens to authenticate. Regularly review your crawler list as new ones emerge to maintain control over your content's visibility and usage.

#AICrawlers #SEO #Publishing
