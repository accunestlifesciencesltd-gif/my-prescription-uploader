// Paste this entire code block into api/upload.js

const shopify = require('@shopify/shopify-api');
const formidable = require('formidable-serverless');
const fs = require('fs');

// ▼▼▼ EDIT THIS LINE ▼▼▼
const SHOP_NAME = 'https://accunest.co.in'; 
// ▲▲▲ EDIT THIS LINE ▲▲▲

const ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN; 

const client = new shopify.Clients.Graphql(SHOP_NAME, ADMIN_API_ACCESS_TOKEN);

const CREATE_FILE_MUTATION = `
  mutation fileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        fileStatus
        originalSource { url }
      }
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
      return res.status(500).json({ error: 'Error processing upload.' });
    }
    try {
      const prescriptionFile = files.prescription_file;
      const fileUploadResponse = await client.query({
        data: {
          query: CREATE_FILE_MUTATION,
          variables: {
            files: {
              alt: `Prescription for order #${fields.order_number}`,
              contentType: prescriptionFile.type,
              originalSource: fs.createReadStream(prescriptionFile.path),
            },
          },
        },
      });
      const uploadedFile = fileUploadResponse.body.data.fileCreate.files[0];
      if (!uploadedFile || uploadedFile.fileStatus !== 'READY') {
          throw new Error('File upload to Shopify failed.');
      }
      const fileUrl = uploadedFile.originalSource.url;
      const orderDataResponse = await client.query({
          data: `{ orders(first: 1, query:"name:${fields.order_number}") { edges { node { id } } } }`
      });
      const orderGid = orderDataResponse.body.data.orders.edges[0]?.node?.id;
      if (!orderGid) {
          throw new Error(`Order with number ${fields.order_number} not found.`);
      }
      const note = `Prescription uploaded.\nFile Link: ${fileUrl}\nCustomer Email: ${fields.customer_email}\nAdditional Notes: ${fields.additional_notes}`;
      await client.query({
          data: {
              query: UPDATE_ORDER_MUTATION,
              variables: { input: { id: orderGid, tags: ['Prescription-Uploaded'], note: note } }
          }
      });
      res.status(200).json({ success: true, message: 'Prescription uploaded successfully!' });
    } catch (error) {
      console.error('Error in upload process:', error.message);
      res.status(500).json({ error: 'An internal server error occurred.' });
    }
  });
};
