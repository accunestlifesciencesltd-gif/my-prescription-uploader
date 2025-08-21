// FINAL, MODERN VERSION - Paste this entire block into api/upload.js

const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
const formidable = require('formidable-serverless');
const fs = require('fs');

const SHOP_NAME = 'accunest.co.in';

// Initialize the Shopify API context. This is the new, correct way.
const shopify = shopifyApi({
  apiVersion: LATEST_API_VERSION,
  isCustomStoreApp: true, // This is the modern term for a private/custom app
  adminApiAccessToken: process.env.SHOPIFY_ADMIN_API_TOKEN,
  // The following is required by the library, but not used for our auth
  apiSecretKey: 'this-secret-can-be-any-string', 
});

const CREATE_FILE_MUTATION = `
  mutation fileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id, fileStatus, originalSource { url } }
      userErrors { field, message }
    }
  }
`;

const UPDATE_ORDER_MUTATION = `
  mutation orderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id, tags }
      userErrors { field, message }
    }
  }
`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', `https://${SHOP_NAME}`);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const form = new formidable.IncomingForm();
  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error('Form parsing error:', err);
      return res.status(500).json({ error: 'Error processing upload.' });
    }
    try {
      // Create a session and a client for this specific request. This is the new pattern.
      const session = shopify.session.customAppSession(SHOP_NAME);
      const client = new shopify.clients.Graphql({ session });

      const prescriptionFile = files.prescription_file;
      if (!prescriptionFile) {
        throw new Error('No prescription file was received by the server.');
      }
      
      const fileUploadResponse = await client.request(CREATE_FILE_MUTATION, {
        variables: {
          files: {
            alt: `Prescription for order #${fields.order_number}`,
            contentType: prescriptionFile.type,
            originalSource: fs.createReadStream(prescriptionFile.path),
          },
        },
      });

      const uploadedFile = fileUploadResponse.data.fileCreate.files[0];
      if (!uploadedFile || uploadedFile.fileStatus !== 'READY') {
        console.error('Shopify file upload failed:', fileUploadResponse.data.fileCreate.userErrors);
        throw new Error('File upload to Shopify failed.');
      }
      const fileUrl = uploadedFile.originalSource.url;

      const orderDataResponse = await client.request(`{ orders(first: 1, query:"name:#${fields.order_number}") { edges { node { id } } } }`);
      const orderGid = orderDataResponse.data.orders.edges[0]?.node?.id;
      if (!orderGid) {
        throw new Error(`Order with number #${fields.order_number} not found.`);
      }
      
      const note = `Prescription uploaded.\nFile Link: ${fileUrl}\nCustomer Email: ${fields.customer_email}\nAdditional Notes: ${fields.additional_notes}`;
      await client.request(UPDATE_ORDER_MUTATION, {
        variables: { input: { id: orderGid, tags: ['Prescription-Uploaded'], note: note } }
      });
      
      res.status(200).json({ success: true, message: 'Prescription uploaded successfully!' });

    } catch (error) {
      console.error('Error in upload process:', error);
      res.status(500).json({ error: 'An internal server error occurred. Please check the Vercel logs.' });
    }
  });
};
