const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node');
const formidable = require('formidable-serverless');
const fs = require('fs');
const SHOP_NAME = 'aq6tap-1i.myshopify.com';

// Initialize the Shopify API context with all required fields
const shopify = shopifyApi({
  hostName: SHOP_NAME,
  apiVersion: '2024-10', // Changed to a string to fix the error
  isCustomStoreApp: true,
  adminApiAccessToken: process.env.SHOPIFY_ADMIN_API_TOKEN,
  apiSecretKey: 'this-secret-can-be-any-string', 
});

// Fixed mutation - removed originalSource field that doesn't exist
const CREATE_FILE_MUTATION = `
  mutation fileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { 
        id 
        fileStatus 
        url
        alt
        createdAt
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
  res.setHeader('Access-Control-Allow-Origin', `https://accunest.co.in`);
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
      const session = shopify.session.customAppSession(SHOP_NAME);
      const client = new shopify.clients.Graphql({ session });
      
      const prescriptionFile = files.prescription_file;
      if (!prescriptionFile) {
        throw new Error('No prescription file was received by the server.');
      }
      
      // Fixed file upload request structure
      const fileUploadResponse = await client.request(CREATE_FILE_MUTATION, {
        variables: {
          files: [{  // Note: this should be an array
            alt: `Prescription for order #${fields.order_number}`,
            contentType: prescriptionFile.type,
            originalSource: fs.createReadStream(prescriptionFile.path),
          }],
        },
      });

      // Check for GraphQL errors
      if (fileUploadResponse.data.fileCreate.userErrors && fileUploadResponse.data.fileCreate.userErrors.length > 0) {
        console.error('Shopify file upload errors:', fileUploadResponse.data.fileCreate.userErrors);
        throw new Error('File upload to Shopify failed: ' + fileUploadResponse.data.fileCreate.userErrors.map(e => e.message).join(', '));
      }

      const uploadedFile = fileUploadResponse.data.fileCreate.files[0];
      if (!uploadedFile || uploadedFile.fileStatus !== 'READY') {
        console.error('Shopify file upload failed. File status:', uploadedFile?.fileStatus);
        throw new Error('File upload to Shopify failed.');
      }

      // Use the correct field name
      const fileUrl = uploadedFile.url;
      
      const orderDataResponse = await client.request(`
        { 
          orders(first: 1, query:"name:#${fields.order_number}") { 
            edges { 
              node { 
                id 
              } 
            } 
          } 
        }
      `);
      
      const orderGid = orderDataResponse.data.orders.edges[0]?.node?.id;
      if (!orderGid) {
        throw new Error(`Order with number #${fields.order_number} not found.`);
      }
      
      const note = `Prescription uploaded.\nFile Link: ${fileUrl}\nCustomer Email: ${fields.customer_email}\nAdditional Notes: ${fields.additional_notes}`;
      
      const orderUpdateResponse = await client.request(UPDATE_ORDER_MUTATION, {
        variables: { 
          input: { 
            id: orderGid, 
            tags: ['Prescription-Uploaded'], 
            note: note 
          } 
        }
      });

      // Check for order update errors
      if (orderUpdateResponse.data.orderUpdate.userErrors && orderUpdateResponse.data.orderUpdate.userErrors.length > 0) {
        console.error('Order update errors:', orderUpdateResponse.data.orderUpdate.userErrors);
        // Still return success since file was uploaded, but log the error
      }
      
      res.status(200).json({ 
        success: true, 
        message: 'Prescription uploaded successfully!',
        fileUrl: fileUrl
      });
      
    } catch (error) {
      console.error('Error in upload process:', error);
      res.status(500).json({ 
        error: 'An internal server error occurred. Please check the Vercel logs.',
        details: error.message 
      });
    }
  });
};
