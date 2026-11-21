# Every WordPress form plugin needs the server check

channel: tumblr
kind: value

When building and maintaining client sites, especially those on WordPress, it's crucial to consider the security and integrity of every form. Contact, comment, login, and checkout forms often come from different plugins, each with its own verification method. To ensure the security of these forms, it's essential to implement server-side verification for each one. 

Start by listing each form on the site and identifying the plugin behind it. Then, confirm that each plugin verifies the token on the server, not just on the client side. This can be done by testing each form with the token removed, which should result in a failed submission if the server-side verification is working correctly.

Additionally, consider implementing key handover and domain allowlists to further secure the forms. Monitoring verify failures and having a spam incident response plan in place can also help mitigate potential issues. It's also important to consider the accessibility of any verification puzzles or challenges, ensuring they don't inadvertently block legitimate users. By taking these steps, you can help protect your clients' sites from spam and ensure a more secure user experience.

#WebDev #WebAgency #Freelance
