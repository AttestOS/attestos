# Every WordPress form plugin needs the server check

channel: tumblr
kind: value

When building and maintaining client sites, especially those on WordPress, it's common to have multiple form plugins for different purposes such as contact, comments, login, and checkout. Each of these plugins may have its own way of handling form submissions and verifying users. To ensure the security and integrity of these forms, it's crucial to implement server-side verification for each one.

Start by listing every form on the site and identifying the plugin behind it. Then, confirm that each plugin verifies the token on the server side. This step is often overlooked, as many plugins only provide client-side validation, which can be bypassed by determined attackers.

Testing each form by removing the token and verifying that the server correctly rejects the submission is also essential. This ensures that the server-side check is indeed working as expected.

Additionally, consider implementing key handover and domain allowlists to further secure your forms. This can help prevent unauthorized access and reduce spam submissions.

It's also important to consider the accessibility of CAPTCHA puzzles, as they can often be a barrier for users with disabilities. Server-side verification can help alleviate this issue by providing an alternative method of verification that doesn't rely on visual puzzles.

Monitoring verify failures and having a spam incident response plan in place can also help identify and mitigate potential security issues. By taking these steps, you can help protect your clients' sites from spam and unauthorized access, and ensure a more secure and reliable user experience.

#WebDev #WebAgency #Freelance
